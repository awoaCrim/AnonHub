import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgent, createMemoryStorage, createUserMessage } from "@yesimbot/agent-runtime";
import { readRoleCard } from "@yesimbot/character-cards";
import { blankRoleCardText, ROLE_SETTINGS, type RoleCardPictureKey, type RoleCardText } from "@yesimbot/contracts/role-cards";
import { contentHash, parseConfig } from "@yesimbot/foundation";
import { asSchema } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Agents } from "../../../core/src/agents/index.js";
import { buildCoreSystemPrompt } from "../../../core/src/runtimes/prompt.js";
import { moduleConfig } from "../src/config.js";
import { extension } from "../src/extension.js";
import { Roleplay } from "../src/roleplay-service.js";

/** The extension's body: Roleplay built from the fake host's Core, parsed config and base directory. */
class RoleplayPlugin extends Roleplay {
  public constructor(ctx: { yesimbot: ConstructorParameters<typeof Roleplay>[0]; baseDir: string }, config: unknown) {
    super(ctx.yesimbot, parseConfig(moduleConfig, config ?? {}), ctx.baseDir);
  }
}

/** The fields of the fake host the tests build. */
interface TestHost {
  yesimbot: ConstructorParameters<typeof Roleplay>[0];
  baseDir: string;
}

type AgentToolLike = {
  name: string;
  capability?: unknown;
  inputSchema: unknown;
  execute: (input: Record<string, unknown>, execution: { toolCallId: string; turnId: string; abortSignal: AbortSignal }) => Promise<unknown>;
};

const roots: string[] = [];

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64");

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);

const WEBP = new Uint8Array(Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64"));

async function stateDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-roleplay-"));
  roots.push(root);
  return root;
}

function pictureFile(key: RoleCardPictureKey, bytes: Uint8Array): string {
  const extension = bytes[0] === 0xff ? "jpg" : bytes[0] === 0x89 ? "png" : "webp";
  return `${key}-${contentHash(bytes, { hexLength: 16 })}.${extension}`;
}

/** Writes card `id` under `root` as the console does: card.json and its pictures beside it. */
async function writeCard(root: string, id: string, text: Partial<RoleCardText> = {}, pictures: Partial<Record<RoleCardPictureKey, Uint8Array>> = {}) {
  const dir = join(root, "data/yesimbot/characters", id);
  await mkdir(dir, { recursive: true });
  const files: Partial<Record<RoleCardPictureKey, string>> = {};
  for (const [key, bytes] of Object.entries(pictures) as Array<[RoleCardPictureKey, Uint8Array]>) {
    files[key] = pictureFile(key, bytes);
    await writeFile(join(dir, files[key]), bytes);
  }
  await writeFile(join(dir, "card.json"), JSON.stringify({ ...blankRoleCardText(id[0]!.toUpperCase() + id.slice(1)), ...text, pictures: files }));
  return dir;
}

/** A fake Core whose resources open `assets` and whose `role` reader can be called per conversation. */
function fakeCore(root: string, choices: Record<string, string> = {}, assets: Record<string, Uint8Array> = {}) {
  const resources = new Map<string, object>();
  const resourcesOf = (channelId: string) =>
    resources.get(channelId) ??
    resources
      .set(channelId, {
        openStrict: async (uri: string) => {
          if (!assets[uri]) throw new Error("resource_not_found");
          return { bytes: assets[uri] };
        },
      })
      .get(channelId)!;
  let reader: { scheme: string; setup: (resources: object, uri: URL) => Promise<unknown> } | undefined;
  const use = vi.fn(() => () => {});
  const ctx = {
    baseDir: root,
    yesimbot: {
      agent: { use },
      overrides: { get: (scope: { channelId: string }) => (scope.channelId in choices ? { roleCard: choices[scope.channelId] } : undefined) },
      resource: {
        get: vi.fn(async (scope: { channelId: string }) => resourcesOf(scope.channelId)),
        use: vi.fn((value: typeof reader) => ((reader = value), () => (reader = undefined))),
      },
    },
  } as unknown as TestHost;
  return {
    ctx,
    use,
    reader: () => reader,
    open: (channelId: string, uri = "role://self/appearance") => reader!.setup(resourcesOf(channelId), new URL(uri)),
  };
}

const direct = (channelId: string) => ({ type: "direct", platform: "web", selfId: "bot", channelId }) as const;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("RoleplayPlugin", () => {
  it("reloads a changed card when the plugin config stays identical", async () => {
    const root = await stateDir();
    await writeCard(root, "athena", { identity: "before edit" });
    const registered: RoleplayPlugin[] = [];
    const disposed = vi.fn();
    const core = {
      resource: { get: async () => ({}), use: () => () => {} },
      agent: {
        use: (plugin: RoleplayPlugin) => {
          registered.push(plugin);
          return disposed;
        },
      },
    };
    const start = () =>
      extension.start({ config: extension.parse({ characterCard: "athena" }), core, baseDir: root } as unknown as Parameters<typeof extension.start>[0]);
    const stop = await start();
    await vi.waitFor(() => expect(registered).toHaveLength(1));
    expect(registered[0]!.resolve(direct("user"))?.characterDefinition).toContain("before edit");
    await writeCard(root, "athena", { identity: "after edit" });
    await (stop as () => unknown)();
    const stopAgain = await start();
    try {
      await vi.waitFor(() => expect(registered).toHaveLength(2));
      expect(disposed).toHaveBeenCalledOnce();
      expect(registered[1]!.resolve(direct("user"))?.characterDefinition).toContain("after edit");
      expect(registered[1]!.resolve(direct("user"))?.characterDefinition).not.toContain("before edit");
    } finally {
      await (stopAgain as () => unknown)();
    }
  });

  it("hands Core one complete card: 角色设定 box by box, then 示例对话, with 回复前提醒 kept for after the history", async () => {
    const root = await stateDir();
    const settings = Object.fromEntries(ROLE_SETTINGS.map(({ key }) => [key, `${key.toUpperCase()}_SENTINEL`]));
    await writeCard(root, "athena", {
      ...settings,
      looks: "",
      nickname: "小雅",
      examples: "对方：你好\n小雅：EXAMPLE_SENTINEL",
      reminder: "REMINDER_SENTINEL",
    });
    const agents = new Agents();
    const ctx = { baseDir: root, yesimbot: { resource: { get: async () => ({}), use: () => () => {} }, agent: agents } } as unknown as TestHost;
    const plugin = new RoleplayPlugin(ctx, { characterCard: "athena" });
    await plugin.start();
    const scope = direct("user");
    const profile = await agents.resolveRoleProfile(scope);
    const plugins = await agents.setup(scope, {} as never, { rolePromptsManaged: true } as never);
    const systemPrompt = vi.fn(() => buildCoreSystemPrompt({ channel: scope, selfId: "bot", roleProfile: profile }));
    const requests: string[] = [];
    const agent = createAgent({
      id: "managed-role",
      plugins,
      systemPrompt,
      storage: createMemoryStorage(),
      maxRetries: 0,
      model: { specificationVersion: "v3", provider: "test", modelId: "test", supportedUrls: {}, doStream: vi.fn() } as never,
      beforeModelRequest: (context) => {
        requests.push(JSON.stringify([context.system, context.messages]));
        throw new Error("Captured request; no provider call needed");
      },
    });
    try {
      await agent.init();
      for (const text of ["first", "second"])
        for await (const _event of agent.run(createUserMessage(text))) {
          /* consume */
        }
      expect(profile?.postHistoryInstructions).toBe("REMINDER_SENTINEL");
      expect(profile?.characterDefinition).toMatch(/^名字：Athena\n自称：小雅\n\n## 身份\nIDENTITY_SENTINEL\n\n## 性格\n/);
      // An empty box is left out.
      expect(profile?.characterDefinition).not.toContain("## 外貌");
      expect(systemPrompt).toHaveBeenCalledOnce();
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        // Core appends 回复前提醒 after the history; it never enters the leading system prompt.
        expect(request).not.toContain("REMINDER_SENTINEL");
        const markers = [...ROLE_SETTINGS.filter(({ key }) => key !== "looks").map(({ key }) => `${key.toUpperCase()}_SENTINEL`), "EXAMPLE_SENTINEL"];
        for (const marker of markers) {
          expect(request.split(marker)).toHaveLength(2);
          expect(request.indexOf(marker)).toBeLessThan(request.indexOf("# 互动策略"));
        }
        const positions = markers.map((marker) => request.indexOf(marker));
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        expect(request).toContain("以下是说话方式的示例，不是这段对话里发生过的事。");
      }
      expect(plugins[0]?.appendSystemPrompt).toBeUndefined();
      expect(plugins[0]?.prepareStep).toBeUndefined();
    } finally {
      await agent.stop();
      await plugin.stop();
    }
  });

  it("speaks with the card a conversation chose, none, or the default", async () => {
    const root = await stateDir();
    await writeCard(root, "athena");
    await writeCard(root, "bob");
    const { ctx, use } = fakeCore(root, { bob: "bob", none: "", gone: "missing" });
    const plugin = new RoleplayPlugin(ctx, { characterCard: "athena", characterCards: ["athena", "bob"] });
    await plugin.start();
    expect(use).toHaveBeenCalledOnce();
    expect(plugin.resolve(direct("bob"))).toEqual({ characterDefinition: "名字：Bob" });
    expect(plugin.resolve(direct("anyone"))).toEqual({ characterDefinition: "名字：Athena" });
    expect(plugin.resolve(direct("gone"))).toEqual({ characterDefinition: "名字：Athena" });
    expect(plugin.resolve(direct("none"))).toBeUndefined();
    await expect(plugin.setup(direct("none"), {} as never)).resolves.toEqual({ name: "roleplay" });
    await plugin.stop();
  });

  it("skips a card it cannot read and still speaks with the others", async () => {
    const root = await stateDir();
    await writeCard(root, "athena");
    const broken = await writeCard(root, "bob");
    await writeFile(join(broken, "card.json"), "{");
    const { ctx } = fakeCore(root, { bob: "bob" });
    const plugin = new RoleplayPlugin(ctx, { characterCard: "athena", characterCards: ["athena", "bob", "../outside"] });
    await plugin.start();
    expect(plugin.resolve(direct("bob"))).toEqual({ characterDefinition: "名字：Athena" });
    await plugin.stop();
  });

  it("offers each card's 参考图 and 三视图 as role://self/… where that card speaks, read when asked for", async () => {
    const root = await stateDir();
    await writeCard(root, "athena", {}, { reference: JPEG, turnaround: PNG });
    await writeCard(root, "bob", {}, { turnaround: PNG });
    await writeCard(root, "carl");
    const { ctx, open, reader } = fakeCore(root, { bob: "bob", carl: "carl" });
    const plugin = new RoleplayPlugin(ctx, { characterCard: "athena", characterCards: ["athena", "bob", "carl"] });
    await plugin.start();
    expect(reader()?.scheme).toBe("role");
    expect(plugin.resolve(direct("anyone"))?.roleInstructions).toContain("形象参考图 role://self/appearance、三视图 role://self/turnaround");
    expect(plugin.resolve(direct("bob"))?.roleInstructions).toContain("你的三视图 role://self/turnaround");
    expect(plugin.resolve(direct("bob"))?.roleInstructions).not.toContain("role://self/appearance");
    expect(plugin.resolve(direct("carl"))?.roleInstructions).toBeUndefined();
    for (const channelId of ["anyone", "bob", "carl"]) await plugin.setup(direct(channelId), {} as never);
    await expect(open("anyone")).resolves.toEqual({ bytes: Buffer.from(JPEG), mediaType: "image/jpeg", filename: "appearance.jpg" });
    await expect(open("anyone", "role://self/turnaround")).resolves.toEqual({ bytes: PNG, mediaType: "image/png", filename: "turnaround.png" });
    await expect(open("bob")).rejects.toMatchObject({ code: "resource_unavailable" });
    await expect(open("carl", "role://self/turnaround")).rejects.toMatchObject({ code: "resource_unavailable" });
    await expect(open("never-set-up")).rejects.toMatchObject({ code: "resource_unavailable" });
    await expect(open("anyone", "role://self/other")).rejects.toMatchObject({ code: "resource_not_found" });
    await plugin.stop();
    expect(reader()).toBeUndefined();

    // A library without pictures registers no reader.
    const plain = await stateDir();
    await writeCard(plain, "carl");
    const quiet = fakeCore(plain);
    const without = new RoleplayPlugin(quiet.ctx, { characterCard: "carl" });
    await without.start();
    expect(quiet.reader()).toBeUndefined();
    await without.stop();
  });

  it("lets the bot edit its own card's boxes and pictures in a private chat, and the next message uses it", async () => {
    const root = await stateDir();
    const dir = await writeCard(root, "athena", { identity: "旧的身份" }, { reference: JPEG });
    const assets: Record<string, Uint8Array> = { "asset://0123456789abcdef0123456789abcdef": WEBP, "asset://text": new TextEncoder().encode("hello") };
    const { ctx, open, use } = fakeCore(root, {}, assets);
    const plugin = new RoleplayPlugin(ctx, { characterCard: "athena" });
    await plugin.start();
    const toolsOf = async (scope: Parameters<RoleplayPlugin["setup"]>[0]) => {
      const agentPlugin = await plugin.setup(scope, {} as never);
      return ((await (agentPlugin.tools as (runtime: unknown) => Promise<AgentToolLike[]>)?.({})) ?? []) as AgentToolLike[];
    };
    // Groups never get the tool; in a private chat it is sensitive, so Core runs it only for admins.
    expect((await toolsOf({ type: "guild", platform: "web", channelId: "group", guildId: "group" } as never)).map((tool) => tool.name)).not.toContain(
      "update_role_card",
    );
    const owner = await plugin.setup(direct("owner"), {} as never);
    const tool = ((await (owner.tools as (runtime: unknown) => Promise<AgentToolLike[]>)({})) as AgentToolLike[]).find(
      (item) => item.name === "update_role_card",
    )!;
    expect(tool.capability).toMatchObject({ sensitive: true, contexts: ["direct"] });
    const schema = (await asSchema(tool.inputSchema as never).jsonSchema) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual([...Object.keys(blankRoleCardText()), "reference", "turnaround"].sort());
    const run = (input: Record<string, unknown>) => tool.execute(input, { toolCallId: "call", turnId: "turn", abortSignal: new AbortController().signal });

    await expect(run({ identity: "新的身份", reference: "asset://0123456789abcdef0123456789abcdef" })).resolves.toMatchObject({
      ok: true,
      changed: ["identity", "reference"],
    });
    const saved = await readRoleCard(root, "athena");
    expect(saved.card).toMatchObject({ identity: "新的身份", pictures: { reference: pictureFile("reference", WEBP) } });
    // The replaced picture's file goes with it.
    expect((await readdir(dir)).sort()).toEqual(["card.json", pictureFile("reference", WEBP)].sort());
    // Not re-registered while the turn runs: that would retire its runtime and refuse its replies (user, 2026-11-27:
    // 「现在让bot改角色卡后，似乎发送消息会被拦截」).
    const registered = use.mock.calls.length;
    expect(plugin.resolve(direct("owner"))?.characterDefinition).toContain("旧的身份");
    // Another conversation's turn ending does not reload it; the editing turn's end (done, aborted or failed) does, once.
    const done = { turnId: "turn", status: "done", messages: [] } as never;
    await (await plugin.setup(direct("other"), {} as never)).onTurnFinish?.(done, {} as never);
    expect(use.mock.calls.length).toBe(registered);
    await owner.onTurnFinish?.(done, {} as never);
    expect(use.mock.calls.length).toBe(registered + 1);
    await owner.onTurnFinish?.(done, {} as never);
    expect(use.mock.calls.length).toBe(registered + 1);
    // Reloaded: the next conversation setup speaks with the new card and reads the new picture.
    expect(plugin.resolve(direct("owner"))?.characterDefinition).toContain("新的身份");
    await plugin.setup(direct("owner"), {} as never);
    await expect(open("owner")).resolves.toMatchObject({ bytes: Buffer.from(WEBP), mediaType: "image/webp", filename: "appearance.webp" });

    // Nothing to change, a non-picture or a missing one is refused without any change; null removes a picture.
    await expect(run({ identity: "新的身份" })).resolves.toMatchObject({ ok: false, error: { code: "role_card_unchanged" } });
    await expect(run({ turnaround: "asset://text" })).resolves.toMatchObject({ ok: false, error: { code: "role_card_picture_unsupported" } });
    await expect(run({ turnaround: "asset://missing" })).resolves.toMatchObject({ ok: false, error: { code: "role_card_picture_unavailable" } });
    await expect(run({ reference: null })).resolves.toMatchObject({ ok: true, changed: ["reference"] });
    await owner.onTurnFinish?.({ turnId: "turn", status: "aborted", messages: [] } as never, {} as never);
    expect((await readRoleCard(root, "athena")).card.pictures).toEqual({});
    expect(await readdir(dir)).toEqual(["card.json"]);
    await plugin.stop();
  });

  it("does not register a role when stopped while its card is loading", async () => {
    const root = await stateDir();
    await writeCard(root, "athena");
    const dispose = vi.fn();
    const use = vi.fn(() => dispose);
    const ctx = { baseDir: root, yesimbot: { resource: { get: async () => ({}), use: () => () => {} }, agent: { use } } } as unknown as TestHost;
    const plugin = new RoleplayPlugin(ctx, { characterCard: "athena" });
    const loading = plugin.start();
    await plugin.stop();
    await loading;
    expect(use).not.toHaveBeenCalled();
    // A later deliberate start still works and its registration can be disposed.
    await plugin.start();
    expect(use).toHaveBeenCalledOnce();
    await plugin.stop();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
