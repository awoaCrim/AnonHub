import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { ChannelContext } from "../src/channels/index.js";
import { YesImBotCore } from "../src/core.js";
import { ChannelResources } from "../src/resources/index.js";
import type { TaskHost } from "../src/tasks/manager.js";
import type { TaskRecord } from "../src/tasks/store.js";
import { TestEvents, testAccount } from "./helpers/index.js";

const directories: string[] = [];
const scope: ChannelContext = { type: "direct", platform: "test", channelId: "channel", selfId: "bot", userId: "user" };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// Preview records, 2026-11-19: a background task made no model retries, so one dropped connection ended it after 48 steps.
it("retries a background task's model requests like the chat does", async () => {
  const path = await mkdtemp(join(tmpdir(), "yesimbot-task-retries-"));
  directories.push(path);
  await writeFile(join(path, "models.json"), "{}");
  const service = new YesImBotCore({
    baseDir: path,
    config: { basePath: path, chatModel: "test:model", modelRetries: 4 },
    events: new TestEvents(),
    account: () => testAccount(scope.platform, scope.selfId),
  });
  await service.model.start();
  service.model.register({
    id: "test",
    capabilities: { chat: true, embedding: false },
    chatModels: () => [{ id: "model" }],
    embeddingModels: () => [],
    chat: () => ({}) as never,
  });
  const internal = service as unknown as { channels: { storedContext: unknown; resolve: unknown } };
  internal.channels.storedContext = vi.fn(async () => scope);
  internal.channels.resolve = vi.fn(async () => ({ conversation: { currentSessionId: () => "session" }, resources: new ChannelResources(path, false) }));
  const host = (service.tasks as unknown as { host: TaskHost }).host;
  const record: TaskRecord = {
    id: "11111111-1111-4111-8111-111111111111",
    channel: "channel",
    session: "session.jsonl",
    key: "retries",
    kind: "computer",
    instruction: "check the server",
    status: "queued",
    createdAt: 0,
    updatedAt: 0,
  };
  const prepared = await host.prepare(record, new AbortController().signal);
  try {
    expect(prepared.config.maxRetries).toBe(4);
  } finally {
    await prepared.release?.();
    await service.tasks.stop();
  }
});
