import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEntry } from "@yesimbot/agent-runtime";
import { parseConfig } from "@yesimbot/foundation";
import { afterEach, expect, it, vi } from "vitest";

import { Agents } from "../src/agents/index.js";
import { Channels, channelDirectoryName } from "../src/channels/index.js";
import { moduleConfig } from "../src/config.js";
import { Runtimes } from "../src/runtimes/index.js";
import { TestEvents } from "./helpers/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(guild = false) {
  const root = await mkdtemp(join(tmpdir(), "managed-archive-"));
  roots.push(root);
  const ctx = new TestEvents();
  const channels = new Channels({ basePath: root });
  const model = { resolveChatModel: vi.fn() };
  const config = parseConfig(moduleConfig, { basePath: root });
  const runtimes = new Runtimes(ctx, channels, model as never, config, new Agents());
  const context = guild
    ? ({ type: "guild", platform: "onebot", selfId: "bot", guildId: "room", channelId: "room" } as const)
    : ({ type: "direct", platform: "onebot", selfId: "bot", userId: "user", channelId: "private:user" } as const);
  const channel = await channels.resolve(context);
  return { channels, channel, runtimes, context, model };
}

it("rotates only the displayed active session, preserves bytes/context and rejects concurrent duplicate requests", async () => {
  const f = await fixture();
  const entry = createEntry("message", { role: "user", content: [{ type: "text", text: "retained history" }] });
  await f.channel.conversation.storage.append(entry);
  const session = `${f.channel.conversation.currentSessionId()}.jsonl`;
  const file = join(f.channel.root, "sessions", session);
  const before = await readFile(file);
  const results = await Promise.allSettled([f.runtimes.archive(f.context, false, session), f.runtimes.archive(f.context, false, session)]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
  expect((results[1] as PromiseRejectedResult).reason.message).toBe("conversation_changed");
  expect(await readFile(file)).toEqual(before);
  expect(await f.channel.conversation.storage.read()).toEqual([entry]);
  expect(await f.channel.conversation.list()).toHaveLength(2);
  expect(f.model.resolveChatModel).not.toHaveBeenCalled();
});

it("rejects empty and stale requests without rotating history", async () => {
  const f = await fixture();
  const session = `${f.channel.conversation.currentSessionId()}.jsonl`;
  await expect(f.runtimes.archive(f.context, false, "old.jsonl")).rejects.toThrow("conversation_changed");
  await expect(f.runtimes.archive(f.context, false, session)).rejects.toThrow("conversation_empty");
  expect(await f.channel.conversation.list()).toHaveLength(1);
});

it("resolves local existing histories only, including after restart, without creating foreign channels", async () => {
  const f = await fixture();
  const key = channelDirectoryName(f.context);
  expect(await f.channels.storedContext(key)).toMatchObject(f.context);
  expect(await f.channels.storedContext("../owner")).toBeUndefined();
  const restarted = new Channels({ basePath: join(f.channel.root, "../..") });
  expect(await restarted.storedContext(key)).toMatchObject(f.context);
  const other = await fixture();
  const foreign = { ...f.context, userId: "other-user", channelId: "private:other-user" };
  await other.channels.resolve(foreign);
  expect(await f.channels.storedContext(channelDirectoryName(foreign))).toBeUndefined();
});

it.each([true, false])("manual fresh archive keeps old bytes but no history or summaries, including restart (guild=%s)", async (guild) => {
  const f = await fixture(guild);
  const message = createEntry("message", { role: "user", content: "OLD_PRIVATE_CONTEXT" });
  await f.channel.conversation.storage.append(message);
  const session = `${f.channel.conversation.currentSessionId()}.jsonl`;
  const oldPath = join(f.channel.root, "sessions", session);
  const before = await readFile(oldPath);
  await f.runtimes.archive(f.context, true, session);
  expect(await f.channel.conversation.storage.read()).toEqual([]);
  expect(await f.channel.conversation.contextRegions()).toEqual([]);
  expect(await readFile(oldPath)).toEqual(before);
  expect(await f.channel.conversation.list()).toHaveLength(2);
  expect(f.model.resolveChatModel).not.toHaveBeenCalled();
  const restarted = new Channels({ basePath: join(f.channel.root, "../..") });
  const restored = await restarted.resolve(f.context);
  expect(await restored.conversation.storage.read()).toEqual([]);
  expect(await readFile(oldPath)).toEqual(before);
  await expect(f.runtimes.archive(f.context, true, session)).rejects.toThrow("conversation_changed");
});
