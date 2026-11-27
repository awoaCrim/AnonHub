import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { WEB_CONVERSATION_ID } from "@yesimbot/contracts/platforms";
import { newId, systemClock, writeFileAtomic, type Clock } from "@yesimbot/foundation";

export const MAX_WEB_CONVERSATIONS = 200;

export const MAX_REACTIONS = 100;

const TITLE_LENGTH = 40;

/** One web conversation as stored. Its history lives with Core under its own channel. */
export interface StoredConversation {
  /** "" is the first conversation (`owner`); later ones are 8 hex digits. */
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** When the account holder last wrote in it; absent while it is still empty. */
  lastMessageAt?: number;
  /** Absent: the current role card from 设置. "": no role card. Otherwise a role card path. */
  roleCard?: string;
  /** Absent: the reply model from 设置. Otherwise a full model ID. */
  chatModel?: string;
  /** The bot's emoji reactions, by the user's message ID; the newest {@link MAX_REACTIONS} are kept. */
  reactions?: Record<string, string>;
}

interface StoredFile {
  version: 1;
  current: string;
  conversations: StoredConversation[];
}

/**
 * The web chat's conversations: which ones exist, which is open, and what each chose. Writes are
 * serialized and atomic; a damaged file starts over with just the first conversation (histories are
 * untouched, they belong to Core).
 */
export class ChatConversations {
  private data: StoredFile = { version: 1, current: "", conversations: [first()] };
  private tail = Promise.resolve();
  public constructor(
    private readonly file: string,
    private readonly clock: Clock = systemClock(),
  ) {}

  public async load(): Promise<void> {
    try {
      this.data = parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch {
      this.data = { version: 1, current: "", conversations: [first()] };
    }
  }

  /** Newest first; the first conversation is always there. */
  public list(): StoredConversation[] {
    return [...this.data.conversations].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
  }
  public get current(): string {
    return this.data.current;
  }
  public get(id: string): StoredConversation | undefined {
    return this.data.conversations.find((item) => item.id === id);
  }

  /** Opens a new conversation; an untouched one is reused instead of piling up empty ones. */
  public create(now = this.clock.now()): Promise<StoredConversation> {
    return this.write(() => {
      let entry = this.data.conversations.find((item) => item.id && item.lastMessageAt === undefined && !item.roleCard && !item.chatModel);
      if (entry) entry.updatedAt = now;
      else {
        if (this.data.conversations.length >= MAX_WEB_CONVERSATIONS) throw new Error("too_many_conversations");
        let id: string;
        do id = newId().slice(0, 8);
        while (this.get(id));
        entry = { id, title: "", createdAt: now, updatedAt: now };
        this.data.conversations.push(entry);
      }
      this.data.current = entry.id;
      return entry;
    });
  }
  public select(id: string): Promise<void> {
    return this.write(() => {
      if (!this.get(id)) throw new Error("conversation_not_found");
      this.data.current = id;
    });
  }
  public update(
    id: string,
    patch: { title?: string; roleCard?: string | null; chatModel?: string | null },
    now = this.clock.now(),
  ): Promise<StoredConversation> {
    return this.write(() => {
      const entry = this.get(id);
      if (!entry) throw new Error("conversation_not_found");
      if (patch.title !== undefined) entry.title = [...patch.title.trim()].slice(0, TITLE_LENGTH).join("");
      if (patch.roleCard === null) delete entry.roleCard;
      else if (patch.roleCard !== undefined) entry.roleCard = patch.roleCard;
      if (patch.chatModel === null) delete entry.chatModel;
      else if (patch.chatModel !== undefined) entry.chatModel = patch.chatModel;
      entry.updatedAt = Math.max(entry.updatedAt, now);
      return entry;
    });
  }
  /** Leaves the list; its history stays under 聊天记录. The first conversation cannot be removed. */
  public remove(id: string): Promise<void> {
    return this.write(() => {
      if (!id || !this.get(id)) throw new Error("conversation_not_found");
      this.data.conversations = this.data.conversations.filter((item) => item.id !== id);
      if (this.data.current === id) this.data.current = this.list()[0]!.id;
    });
  }
  /** The bot reacted to a message; a later reaction to the same message replaces it. */
  public react(id: string, messageId: string, emoji: string): Promise<void> {
    return this.write(() => {
      const entry = this.get(id);
      if (!entry) throw new Error("conversation_not_found");
      const reactions = Object.entries(entry.reactions ?? {}).filter(([key]) => key !== messageId);
      reactions.push([messageId, emoji]);
      entry.reactions = Object.fromEntries(reactions.slice(-MAX_REACTIONS));
    });
  }
  /** A message was written: it moves to the top, and an untitled conversation is named after it. */
  public touch(id: string, text: string | undefined, now = this.clock.now()): Promise<void> {
    return this.write(() => {
      const entry = this.get(id);
      if (!entry) return;
      entry.updatedAt = now;
      if (text !== undefined) {
        entry.lastMessageAt = now;
        if (!entry.title && entry.id) entry.title = titleOf(text);
      }
    });
  }

  private write<T>(change: () => T): Promise<T> {
    const run = this.tail.then(async () => {
      const result = change();
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.file, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
      return result;
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

const titleOf = (text: string) => [...text.replace(/\s+/g, " ").trim()].slice(0, 24).join("");

function reactionsOf(value: unknown): Pick<StoredConversation, "reactions"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => entry[0].length <= 128 && typeof entry[1] === "string" && entry[1].length <= 32)
    .slice(-MAX_REACTIONS);
  return entries.length ? { reactions: Object.fromEntries(entries) } : {};
}

function first(): StoredConversation {
  return { id: "", title: "", createdAt: 0, updatedAt: 0 };
}

function parse(value: unknown): StoredFile {
  const file = value as Partial<StoredFile> | null;
  if (!file || file.version !== 1 || !Array.isArray(file.conversations)) throw new Error("invalid_file");
  const conversations: StoredConversation[] = [];
  for (const item of file.conversations.slice(0, MAX_WEB_CONVERSATIONS)) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || (item.id && !WEB_CONVERSATION_ID.test(item.id))) continue;
    if (conversations.some((entry) => entry.id === item.id)) continue;
    const time = (input: unknown) => (Number.isSafeInteger(input) && (input as number) >= 0 ? (input as number) : 0);
    conversations.push({
      id: item.id,
      title: typeof item.title === "string" ? [...item.title].slice(0, TITLE_LENGTH).join("") : "",
      createdAt: time(item.createdAt),
      updatedAt: time(item.updatedAt),
      ...(item.lastMessageAt !== undefined ? { lastMessageAt: time(item.lastMessageAt) } : {}),
      ...(typeof item.roleCard === "string" ? { roleCard: item.roleCard } : {}),
      ...(typeof item.chatModel === "string" && item.chatModel ? { chatModel: item.chatModel } : {}),
      ...reactionsOf(item.reactions),
    });
  }
  if (!conversations.some((entry) => entry.id === "")) conversations.unshift(first());
  const current = typeof file.current === "string" && conversations.some((entry) => entry.id === file.current) ? file.current : "";
  return { version: 1, current, conversations };
}
