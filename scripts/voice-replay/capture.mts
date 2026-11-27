/**
 * Rebuild the exact first model request of each replay case through the real ChannelRuntime.
 *
 * Each case history is loaded into a throwaway channel root, the triggering message is fed back
 * through `runtime.handle`, and a stub model records the provider-neutral call options before
 * answering with `finish`. Nothing is sent anywhere.
 *
 * Usage:
 *   yarn tsx scripts/voice-replay/capture.mts <work-dir> <variant> <gemini-native|default> \
 *     [--own-history <n>] [--post-history <file>] [--mes-example-append <file>] [--persona <file>]
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { Channel, type ChannelContext } from "../../core/src/channels/index.js";
import type { Config } from "../../core/src/config.js";
import type { MessageRecord } from "../../core/src/messages/index.js";
import { ChannelRuntime } from "../../core/src/runtimes/channel.js";
import { decodeRoleCard } from "../../packages/character-cards/src/index.js";
import type { RoleCard } from "../../packages/contracts/src/role-cards.js";
import { assembleRoleProfile } from "../../plugins/roleplay/src/prompt.js";

const options = parseArgs(process.argv.slice(2));

interface ReplayOptions {
  readonly work: string;
  readonly variant: string;
  readonly projection: "gemini-native" | "default";
  readonly ownHistory?: number;
  /** Candidate 回复前提醒 file; replaces the card's for this variant only. */
  readonly reminder?: string;
  /** Extra 示例对话 appended to the card's for this variant only. */
  readonly examplesAppend?: string;
  /** Replacement PERSONA.md for this variant only; production persona is the default. */
  readonly persona?: string;
  /** JSON of card text fields that replace the card's for this variant only. */
  readonly cardFields?: string;
}

function parseArgs(argv: readonly string[]): ReplayOptions {
  const [work, variant, projection, ...flags] = argv;
  if (!work || !variant || (projection !== "gemini-native" && projection !== "default")) {
    console.error(
      "usage: capture.mts <work-dir> <variant> <gemini-native|default> [--own-history <n>] [--reminder <file>] [--examples-append <file>] [--persona <file>] [--card-fields <file>]",
    );
    process.exit(2);
  }
  const optionsWithValue = new Set(["--own-history", "--reminder", "--examples-append", "--persona", "--card-fields"]);
  for (let index = 0; index < flags.length; index += 2) {
    if (!optionsWithValue.has(flags[index]!) || !flags[index + 1] || flags[index + 1]!.startsWith("--")) {
      throw new Error(`Unknown option or missing value: ${flags[index]}`);
    }
  }
  const ownHistoryFlag = flags.indexOf("--own-history");
  const reminderFlag = flags.indexOf("--reminder");
  const examplesFlag = flags.indexOf("--examples-append");
  const personaFlag = flags.indexOf("--persona");
  const cardFieldsFlag = flags.indexOf("--card-fields");
  return {
    ...(cardFieldsFlag >= 0 ? { cardFields: resolve(flags[cardFieldsFlag + 1]!) } : {}),
    work: resolve(work),
    variant,
    projection,
    ...(ownHistoryFlag >= 0 ? { ownHistory: Number(flags[ownHistoryFlag + 1]) } : {}),
    ...(reminderFlag >= 0 ? { reminder: resolve(flags[reminderFlag + 1]!) } : {}),
    ...(examplesFlag >= 0 ? { examplesAppend: resolve(flags[examplesFlag + 1]!) } : {}),
    ...(personaFlag >= 0 ? { persona: resolve(flags[personaFlag + 1]!) } : {}),
  };
}

function productionConfig(basePath: string): Config {
  // Mirrors the owner instance yesimbot config read on 2026-11-01; image/video input are off because
  // replay roots do not carry provider-readable media.
  return {
    basePath,
    chatModel: "replay:stub",
    visionModel: undefined,
    logLevel: 1,
    allowedChannels: [],
    imageInput: false,
    resourceReadTimeout: 60,
    will: { engine: "routing", direct: "trigger", mention: "trigger", group: "trigger" },
    pacing: { charactersPerSecond: 1000, maxTotalDelayMs: 0 },
    customInnerThought: false,
    session: {
      archive: { maxKB: 5120 },
      magicContext: {},
      ...(options.ownHistory !== undefined ? { ownHistoryVerbatim: options.ownHistory } : {}),
    },
  } as unknown as Config;
}

async function captureCase(caseDir: string, card: RoleCard, persona: string): Promise<unknown> {
  const meta = JSON.parse(await readFile(join(caseDir, "channel.json"), "utf8")) as ChannelContext & { selfId: string; userId?: string };
  const trigger = JSON.parse(await readFile(join(caseDir, "trigger.json"), "utf8"));
  const stored = trigger.data.data as Omit<MessageRecord, "timestamp">;

  const root = await mkdtemp(join(tmpdir(), "voice-replay-"));
  try {
    const basePath = join(root, "yesimbot");
    const channelRoot = join(basePath, "channels", "replay");
    await mkdir(join(channelRoot, "sessions"), { recursive: true });
    await writeFile(join(basePath, "PERSONA.md"), persona);
    await writeFile(join(basePath, "AGENTS.md"), "");
    const caseMeta = JSON.parse(await readFile(join(caseDir, "case.json"), "utf8")) as { channel: string; session: string };
    // Context regions are bound to their session lineage; keep the production session id.
    await cp(join(caseDir, "history.jsonl"), join(channelRoot, "sessions", caseMeta.session));
    await symlink(join(options.work, "raw", "channels", caseMeta.channel, "assets"), join(channelRoot, "assets")).catch(() => {});

    // Older direct roots were created before the `private:` prefix; the record's channel id wins.
    meta.channelId = stored.channel.id;
    const scope: ChannelContext =
      meta.type === "direct"
        ? { type: "direct", platform: meta.platform, channelId: meta.channelId, selfId: meta.selfId, userId: meta.userId! }
        : { type: meta.type, platform: meta.platform, channelId: meta.channelId, guildId: meta.guildId! };
    const config = productionConfig(basePath);
    const channel = new Channel(scope, channelRoot);
    await channel.conversation.init();

    let recorded: unknown;
    const model = new MockLanguageModelV3({
      provider: "replay",
      modelId: "stub",
      doStream: async (options) => {
        recorded ??= {
          prompt: options.prompt,
          tools: options.tools,
          toolChoice: options.toolChoice,
          maxOutputTokens: options.maxOutputTokens,
          temperature: options.temperature,
          topP: options.topP,
          providerOptions: options.providerOptions,
        };
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "tool-call", toolCallId: "replay-finish", toolName: "finish", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
            ] as never,
          }),
        };
      },
    });

    const roleProfile = assembleRoleProfile(card);

    const runtime = new ChannelRuntime(
      { emit: () => {}, on: () => () => {} },
      {
        channel,
        bot: { selfId: meta.selfId, platform: meta.platform, sendMessage: async () => ["replay-sent"] } as never,
        will: { decide: async () => "trigger" as const, observe: () => {} },
        model,
        historyProjection: options.projection,
        contextModelLimit: { context: 147200, output: 8192 },
        readImagePolicy: { mode: "native" },
        config,
        plugins: [],
        roleProfile,
      },
    );
    if (process.env.REPLAY_DEBUG) {
      // Surface ContextWorkspace budget decisions while diagnosing replay/production drift.
      const workspace = Reflect.get(runtime, "contextWorkspace") as object | undefined;
      const workspaceOptions = workspace && (Reflect.get(workspace, "options") as Record<string, unknown>);
      if (workspace && workspaceOptions)
        Reflect.set(workspace, "options", { ...workspaceOptions, onDiagnostic: (metadata: unknown) => console.error("diag", JSON.stringify(metadata)) });
    }
    await runtime.init();
    try {
      const record: MessageRecord = { ...stored, timestamp: trigger.data.timestamp };
      const outcome = await runtime.handle(record);
      if (process.env.REPLAY_DEBUG) console.error("handle outcome", outcome.kind, JSON.stringify(outcome).slice(0, 300));
      if (outcome.kind === "run") await outcome.done;
      await runtime.wait();
    } finally {
      await runtime.stop();
    }
    return recorded;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { work, variant, projection } = options;
  const original = decodeRoleCard(await readFile(join(work, "raw", "card.json")));
  const card: RoleCard = { ...original, ...(options.cardFields ? JSON.parse(await readFile(options.cardFields, "utf8")) : {}) };
  if (options.examplesAppend) card.examples = `${card.examples.trim()}\n\n${(await readFile(options.examplesAppend, "utf8")).trim()}`;
  if (options.reminder) card.reminder = (await readFile(options.reminder, "utf8")).trim();
  const persona = await readFile(options.persona ?? join(work, "raw", "PERSONA.md"), "utf8");
  const outDir = join(work, "requests", variant, projection);
  await mkdir(outDir, { recursive: true });
  const only = process.env.REPLAY_CASES?.split(",").filter(Boolean);
  for (const id of (await readdir(join(work, "cases"))).sort()) {
    if (only && !only.includes(id)) continue;
    try {
      const request = await captureCase(join(work, "cases", id), card, persona);
      if (!request) throw new Error("runtime did not call the model");
      await writeFile(join(outDir, `${id}.json`), JSON.stringify(request));
      console.log(`captured ${variant}/${projection}/${id}`);
    } catch (error) {
      console.error(`failed ${id}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  }
}

await main();
process.exit(0);
