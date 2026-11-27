import fs from "node:fs/promises";
import { join, resolve } from "node:path";

import { channelStorageDirectory } from "@yesimbot/contracts";
import { AppError, createDirectory, logger, resolveInside, systemClock, writeFileAtomic, type Clock } from "@yesimbot/foundation";

import { Conversation, type ConversationReadOptions } from "../conversations/index.js";
import type { MessageRecord } from "../messages/index.js";
import { ChannelResources, type Disposer, type ResourceReader, type Resources } from "../resources/index.js";
import { type ChannelContext, type ChannelKey, deriveChannelKey } from "./context.js";
import { CHANNEL_ERRORS } from "./errors.js";

const log = logger("channels");

// ─── Types ─────────────────────────────────────────────────────────────────

type ChannelManifest = ChannelContext & { readonly createdAt: string };

export interface ChannelsOptions {
  readonly basePath: string;
  readonly clock?: Clock;
  readonly imageInput?: boolean;
  readonly videoInput?: boolean;
  readonly readTimeoutMs?: number;
}

// ─── Channel ───────────────────────────────────────────────────────────────

export class Channel {
  public readonly resources: ChannelResources;
  public readonly conversation: Conversation;

  public constructor(
    public readonly context: ChannelContext,
    public readonly root: string,
    imageInput = false,
    readTimeoutMs = 10_000,
    videoInput = false,
  ) {
    this.resources = new ChannelResources(root, imageInput, readTimeoutMs, videoInput);
    this.conversation = new Conversation(root);
  }
}

// ─── Channels ──────────────────────────────────────────────────────────────

export class Channels implements Resources {
  private readonly channelsPath: string;
  private readonly manifests = new Map<string, ChannelManifest>();
  private readonly channels = new Map<string, Channel>();
  private readonly creating = new Map<string, Promise<Channel>>();
  private readonly readers = new Map<string, ResourceReader>();
  private readonly readerDisposers = new Map<ResourceReader, Map<Channel, Disposer>>();
  private readonly imageInput: boolean;
  private readonly videoInput: boolean;
  private readonly readTimeoutMs: number;
  private readonly clock: Clock;
  private readonly started: Promise<void>;

  public constructor(options: ChannelsOptions) {
    this.channelsPath = resolve(options.basePath, "channels");
    this.imageInput = options.imageInput ?? false;
    this.videoInput = options.videoInput ?? false;
    this.readTimeoutMs = options.readTimeoutMs ?? 10_000;
    this.clock = options.clock ?? systemClock();
    this.started = this.scan();
  }

  public start(): Promise<void> {
    return this.started;
  }

  public async resolve(ctx: ChannelContext): Promise<Channel> {
    await this.started;
    const key = deriveChannelKey(ctx);
    const cached = this.channels.get(key);
    if (cached) return cached;
    const creating = this.creating.get(key);
    if (creating) return creating;
    const task = this.create(ctx, key);
    this.creating.set(key, task);
    try {
      return await task;
    } finally {
      this.creating.delete(key);
    }
  }

  public async get(ctx: ChannelContext): Promise<ChannelResources> {
    return (await this.resolve(ctx)).resources;
  }

  public async readConversation(context: ChannelContext, options: ConversationReadOptions): Promise<MessageRecord[]> {
    return (await this.resolve(context)).conversation.read(options);
  }

  /** Resolve an existing local history entry without creating a caller-selected channel. */
  public async storedContext(directory: string): Promise<ChannelContext | undefined> {
    await this.started;
    return [...this.manifests.values()].find((manifest) => channelDirectoryName(manifest) === directory);
  }

  public use(reader: ResourceReader): Disposer {
    if (this.readers.has(reader.scheme)) throw new AppError(CHANNEL_ERRORS.channel_reader_duplicate, { detail: reader.scheme });
    const disposers = new Map<Channel, Disposer>();
    this.readers.set(reader.scheme, reader);
    this.readerDisposers.set(reader, disposers);
    for (const channel of this.channels.values()) {
      disposers.set(channel, channel.resources.use(reader));
    }
    return () => {
      if (this.readers.get(reader.scheme) !== reader) return;
      this.readers.delete(reader.scheme);
      this.readerDisposers.delete(reader);
      for (const dispose of disposers.values()) dispose();
    };
  }

  public async reset(ctx: ChannelContext): Promise<void> {
    const key = deriveChannelKey(ctx);
    const channel = await this.resolve(ctx);
    log.debug("channels.reset", { key, root: channel.root });
    await Promise.all([
      fs.rm(join(channel.root, "sessions"), { recursive: true, force: true }),
      channel.resources.assets.clear(),
      channel.resources.artifacts.clear(),
    ]);
    this.channels.delete(key);
  }

  private async create(ctx: ChannelContext, key: ChannelKey): Promise<Channel> {
    const root = await this.ensureRoot(ctx);
    const channel = new Channel(ctx, root, this.imageInput, this.readTimeoutMs, this.videoInput);
    for (const reader of this.readers.values()) {
      this.readerDisposers.get(reader)!.set(channel, channel.resources.use(reader));
    }
    await channel.conversation.init();
    this.channels.set(key, channel);
    log.debug("channels.resolve.created", { key, root });
    return channel;
  }

  private async scan(): Promise<void> {
    await fs.mkdir(this.channelsPath, { recursive: true });
    for (const entry of await fs.readdir(this.channelsPath, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory()) {
        log.error("storage.directory.invalid", { entry: entry.name });
        continue;
      }
      try {
        const manifest = parseManifest(JSON.parse(await fs.readFile(join(this.channelsPath, entry.name, "channel.json"), "utf8")) as unknown);
        // Records are versionless and old layouts are not migrated (production checked 2026-11-24: none left).
        if (entry.name !== channelDirectoryName(manifest))
          throw new AppError(CHANNEL_ERRORS.channel_storage_invalid, { detail: "manifest does not match its directory name" });
        this.manifests.set(deriveChannelKey(manifest), manifest);
      } catch (cause) {
        log.error("storage.manifest_invalid", { directoryName: entry.name, cause });
      }
    }
  }

  private async ensureRoot(ctx: ChannelContext): Promise<string> {
    const key = deriveChannelKey(ctx);
    if (!this.manifests.has(key)) {
      const directory = channelDirectoryName(ctx);
      const root = join(this.channelsPath, directory);
      try {
        const stat = await fs.lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new AppError(CHANNEL_ERRORS.channel_storage_invalid, { detail: "storage destination is not a directory" });
        const manifest = parseManifest(JSON.parse(await fs.readFile(join(root, "channel.json"), "utf8")));
        if (deriveChannelKey(manifest) !== key)
          throw new AppError(CHANNEL_ERRORS.channel_storage_invalid, { detail: "manifest belongs to another conversation" });
        this.manifests.set(key, manifest);
      } catch (cause) {
        if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")) throw cause;
        const manifest = { ...ctx, createdAt: new Date(this.clock.now()).toISOString() } as ChannelManifest;
        // Readers never see a conversation directory without its manifest.
        await createDirectory(root, (staging) => writeManifest(staging, manifest));
        this.manifests.set(key, manifest);
      }
    }
    const root = join(this.channelsPath, channelDirectoryName(ctx));
    try {
      await resolveInside(this.channelsPath, channelDirectoryName(ctx), { links: "reject" });
    } catch (cause) {
      throw new AppError(CHANNEL_ERRORS.channel_storage_invalid, { cause, detail: "conversation directory is a link or outside the channels directory" });
    }
    return root;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

export function channelDirectoryName(ctx: ChannelContext): string {
  return channelStorageDirectory(ctx);
}

function parseManifest(value: unknown): ChannelManifest {
  const invalid = (detail: string) => new AppError(CHANNEL_ERRORS.channel_storage_invalid, { detail });
  if (typeof value !== "object" || value === null) throw invalid("manifest is not an object");
  const raw = value as Record<string, unknown>;
  const text = (key: string) => typeof raw[key] === "string" && (raw[key] as string).length > 0;
  if (!text("platform") || !text("channelId") || typeof raw.createdAt !== "string") throw invalid("manifest is missing platform, channelId or createdAt");
  if (raw.type === "direct" ? text("selfId") && text("userId") : (raw.type === "guild" || raw.type === "channel") && text("guildId"))
    return raw as unknown as ChannelManifest;
  throw invalid(`manifest of type ${String(raw.type)} is incomplete`);
}

function writeManifest(directory: string, manifest: ChannelManifest): Promise<void> {
  return writeFileAtomic(join(directory, "channel.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export { type ChannelContext, type ChannelKey, deriveChannelKey, contextFromRecord } from "./context.js";
