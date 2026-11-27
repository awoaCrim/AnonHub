import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { systemClock } from "@yesimbot/foundation";
import { afterEach, expect, it, vi } from "vitest";

import { buildConversationIndex } from "../src/conversation-history.js";
import { chatHistory, installHistory } from "../src/webui/history.js";
import { TopicRegistry } from "../src/webui/topics.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** The records Xiaoheihe wrote while it was a platform: one event round and the model's reply, in an `account:` channel. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "xhh-legacy-"));
  roots.push(root);
  const write = async (key: string, manifest: Record<string, unknown>, lines: unknown[]) => {
    const dir = join(root, "data/yesimbot/channels", key);
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "channel.json"), JSON.stringify({ type: "guild", createdAt: "2026-10-28T00:00:00Z", ...manifest }));
    await writeFile(join(dir, "sessions/20261028T000000Z.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  };
  await write("shared-xiaoheihe-account", { platform: "xiaoheihe", channelId: "account:1234", selfId: "1234" }, [
    { type: "event", data: { type: "xiaoheihe.round" }, timestamp: 100 },
    { type: "event", data: { type: "xiaoheihe.thread" }, timestamp: 200 },
  ]);
  await write("shared-onebot-room", { platform: "onebot", channelId: "room" }, [{ type: "event", data: { type: "fixture.event" }, timestamp: 300 }]);
  const ctx = {
    baseDir: root,
    clock: systemClock(),
    bots: [],
    on: vi.fn(),
    setInterval: vi.fn(() => () => {}),
    loader: { config: { plugins: { "group:yesimbot": { yesimbot: { basePath: "data/yesimbot" } } } } },
  };
  return { root, ctx };
}

it("keeps the old Xiaoheihe conversations readable in 会话管理, labelled as old records, and out of every chat use", async () => {
  const { ctx } = await fixture();
  const routes = new Map<string, (http: unknown) => Promise<void>>();
  const topics = new TopicRegistry();
  installHistory(
    { ...ctx, clock: systemClock(), server: { post: (path: string, handler: (http: unknown) => Promise<void>) => routes.set(path, handler) } } as never,
    { sessionFromCookie: () => ({ role: "owner" }), sameOrigin: () => true } as never,
    topics,
  );
  // The list shows them beside the other chats.
  const index = (await topics.get("conversations")!.get({ role: "owner" } as never)) as Awaited<ReturnType<typeof buildConversationIndex>>;
  expect(index.channels.map((channel) => [channel.key, channel.platform]).sort()).toEqual([
    ["shared-onebot-room", "onebot"],
    ["shared-xiaoheihe-account", "xiaoheihe"],
  ]);
  // And their records open; the route only reads.
  const http: { set: unknown; get: (name: string) => string; request: object; status: number; body?: { entries?: unknown[]; message?: string } } = {
    set: vi.fn(),
    get: (name) => (name === "content-type" ? "application/json" : ""),
    request: { body: { channel: "shared-xiaoheihe-account", session: "20261028T000000Z.jsonl" } },
    status: 200,
  };
  await routes.get("/yesimbot/api/v1/conversations/detail")!(http);
  expect(http.status).toBe(200);
  expect(http.body?.entries).toHaveLength(2);
  // Chat consumers (the 全局大脑 and the prompt overview) never list them: nothing can run on a retired platform.
  const live = await buildConversationIndex(ctx as never, chatHistory, false);
  expect(live.channels.map((channel) => channel.platform)).toEqual(["onebot"]);
});
