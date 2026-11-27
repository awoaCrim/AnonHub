import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileToolJournal, type AgentTool } from "@yesimbot/agent-runtime";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelContext } from "../src/channels/context.js";
import { YesImBotCore } from "../src/core.js";
import { Tasks, type TaskHost } from "../src/tasks/manager.js";
import { selectTaskModel, taskModelChoices } from "../src/tasks/models.js";
import { TaskStore, type TaskRecord } from "../src/tasks/store.js";
import { TestEvents, testAccount } from "./helpers/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function directory() {
  const value = await mkdtemp(join(tmpdir(), "yesimbot-task-models-"));
  directories.push(value);
  return value;
}
const origin = { channel: "channel", session: "session.jsonl" };
const scope: ChannelContext = { type: "direct", platform: "test", channelId: "channel", selfId: "bot", userId: "user" };
function reportingModel(onRequest: () => void = () => {}) {
  return new MockLanguageModelV3({
    doStream: async () => {
      onRequest();
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "report", toolName: "task_report", input: JSON.stringify({ status: "waiting", result: "needs next instruction" }) },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          },
        ]),
      };
    },
  });
}

describe("background-task model policy", () => {
  it("uses ordered configured refs, otherwise the effective current model, without mutating either", () => {
    const configured = ["provider:second", "provider:first"];
    const choices = taskModelChoices(configured, "provider:current");
    expect(selectTaskModel(choices)).toBe("provider:second");
    expect(selectTaskModel(choices, "provider:first")).toBe("provider:first");
    choices.reverse();
    expect(configured).toEqual(["provider:second", "provider:first"]);
    for (const empty of [undefined, []]) expect(taskModelChoices(empty, "provider:current")).toEqual(["provider:current"]);
    expect(() => selectTaskModel(configured, "provider:current")).toThrow("task_model_not_allowed");
    expect(() => selectTaskModel(configured, undefined, ["provider:first"])).toThrow("task_model_unavailable");
    expect(() => selectTaskModel([])).toThrow("task_model_unavailable");
  });

  it("pins defaults and explicit models through actual worker requests and continuation", async () => {
    const path = await directory();
    let allowed = ["p:first", "p:second"];
    const requests: string[] = [];
    const models = { "p:first": reportingModel(() => requests.push("p:first")), "p:second": reportingModel(() => requests.push("p:second")) };
    const manager = new Tasks(path, {
      modelChoices: () => allowed,
      prepare: async (record) => ({ config: { model: models[selectTaskModel(allowed, record.modelRef, Object.keys(models)) as keyof typeof models] } }),
      notify: async () => "delivered",
      diagnostic: vi.fn(),
      changed() {},
    });
    await manager.start();
    try {
      const first = await manager.create(origin, "content", "first", "first");
      const second = await manager.create(origin, "content", "second", "second", [], { model: "p:second" });
      await vi.waitFor(async () => expect((await manager.store.get(second.id))?.notification).toBe("delivered"));
      expect(first.modelRef).toBe("p:first");
      expect(second.modelRef).toBe("p:second");
      expect(requests).toEqual(["p:first", "p:second"]);
      await expect(manager.create(origin, "content", "not allowed", "invalid", [], { model: "p:other" })).rejects.toThrow("task_model_not_allowed");
      expect(await manager.store.list()).toHaveLength(2);
      allowed = ["p:first"];
      await manager.update(second.id, "continue");
      await vi.waitFor(async () => expect((await manager.store.get(second.id))?.notification).toBe("delivered"));
      expect((await manager.store.get(second.id))?.status).toBe("failed");
      expect((await manager.store.get(second.id))?.modelRef).toBe("p:second");
      expect((await manager.store.get(second.id))?.result).toContain("可用列表");
      expect(requests).toEqual(["p:first", "p:second"]);
      expect((await new TaskStore(path).get(second.id))?.modelRef).toBe("p:second");
    } finally {
      await manager.stop();
    }
  });

  it("keeps legacy hosts and old stored tasks without a modelRef compatible", async () => {
    const path = await directory();
    const manager = new Tasks(path, {
      prepare: async () => ({ config: { model: reportingModel() } }),
      notify: async () => "delivered",
      diagnostic() {},
      changed() {},
    });
    await manager.start();
    try {
      const record = await manager.create(origin, "content", "legacy host", "legacy");
      await vi.waitFor(async () => expect((await manager.store.get(record.id))?.notification).toBe("delivered"));
      expect((await manager.store.get(record.id))?.status).toBe("waiting");
      expect(record).not.toHaveProperty("modelRef");
      expect((await new TaskStore(path).get(record.id))?.modelRef).toBeUndefined();
    } finally {
      await manager.stop();
    }
  });

  it("returns the existing keyed record unchanged after its model is removed", async () => {
    const path = await directory();
    const prepare = vi.fn();
    const manager = new Tasks(path, { modelChoices: () => ["p:new"], prepare, notify: async () => "delivered", diagnostic() {}, changed() {} });
    const { record } = await manager.store.create({ ...origin, kind: "content", key: "same", instruction: "original", modelRef: "p:old" });
    await manager.store.update(record.id, (row) => {
      row.status = "waiting";
    });
    const existing = await manager.store.get(record.id);
    expect(await manager.create(origin, "computer", "replacement", "same", [], { model: "p:other" })).toEqual(existing);
    expect(await manager.store.list()).toHaveLength(1);
    expect(prepare).not.toHaveBeenCalled();
    await manager.stop();
  });

  it("pins a legacy task on its first resumed worker request and validates before later updates", async () => {
    const path = await directory();
    let choices = ["p:first"];
    const requests = vi.fn();
    const manager = new Tasks(path, {
      modelChoices: () => choices,
      validateModel: (record) => {
        selectTaskModel(choices, record.modelRef);
      },
      prepare: async (record) => ({ modelRef: selectTaskModel(choices, record.modelRef), config: { model: reportingModel(requests) } }),
      notify: async () => "delivered",
      diagnostic() {},
      changed() {},
    });
    const { record } = await manager.store.create({ ...origin, kind: "content", key: "legacy", instruction: "old task" });
    await manager.store.update(record.id, (row) => {
      row.status = "waiting";
    });
    await manager.start();
    try {
      await manager.update(record.id, "resume");
      await vi.waitFor(async () => expect((await manager.store.get(record.id))?.notification).toBe("delivered"));
      expect((await manager.store.get(record.id))?.modelRef).toBe("p:first");
      expect(requests).toHaveBeenCalledTimes(1);
      choices = ["p:second"];
      const before = await manager.store.get(record.id);
      await expect(manager.update(record.id, "must not mutate")).rejects.toThrow("task_model_not_allowed");
      expect(await manager.store.get(record.id)).toEqual(before);
      expect(requests).toHaveBeenCalledTimes(1);
    } finally {
      await manager.stop();
    }
  });

  it("journals model validation as not_started but retains unknown after a store write fails", async () => {
    const path = await directory();
    let choices = ["p:first", "p:second"];
    const manager = new Tasks(path, {
      modelChoices: () => choices,
      validateModel: (record) => {
        selectTaskModel(choices, record.modelRef);
      },
      prepare: vi.fn(),
      notify: async () => "delivered",
      diagnostic() {},
      changed() {},
    });
    await manager.start();
    const tools = manager.plugin(origin).tools as AgentTool[];
    const journal = createFileToolJournal(join(path, "validation-journal"));
    const invoke = (name: string, input: unknown, id: string) => {
      const tool = tools.find((item) => item.name === name)!;
      const call = { turnId: "turn", toolCallId: id, toolName: name, input };
      return journal.execute(call, async () => tool.execute(input, { ...call, messages: [] } as never));
    };
    try {
      choices = ["p:first"];
      const rejected = await invoke("task_create", { kind: "content", timeLimitMinutes: 30, instruction: "invalid", model: "p:second" }, "invalid");
      expect(rejected).toMatchObject({ ok: false, executionStatus: "not_started", changed: false, error: { code: "task_model_not_allowed" } });
      expect(await invoke("task_create", { kind: "content", timeLimitMinutes: 30, instruction: "invalid", model: "p:second" }, "invalid")).toEqual(rejected);
      expect(await manager.store.list()).toHaveLength(0);

      const { record } = await manager.store.create({ ...origin, kind: "content", key: "waiting", instruction: "keep", modelRef: "p:second" });
      await manager.store.update(record.id, (row) => {
        row.status = "waiting";
        row.handoff = { id: "22222222-2222-4222-8222-222222222222", state: "pending", instruction: "login", requestedAt: 0 };
      });
      const before = await manager.store.get(record.id);
      expect(await invoke("task_control", { id: record.id, action: "update", instruction: "must not append" }, "update")).toMatchObject({
        executionStatus: "not_started",
        changed: false,
      });
      await expect(manager.resolveHandoff(record.id, before!.handoff!.id)).rejects.toThrow("task_model_not_allowed");
      expect(await manager.store.get(record.id)).toEqual(before);

      const create = manager.store.create.bind(manager.store);
      vi.spyOn(manager.store, "create").mockImplementationOnce(async (input) => {
        await create(input);
        throw new Error("failure after write");
      });
      const unknown = await invoke("task_create", { kind: "content", timeLimitMinutes: 30, instruction: "written", model: "p:first" }, "written");
      expect(unknown).toMatchObject({ code: "execution_unknown", executionStatus: "unknown" });
      expect((await manager.store.list()).find((item) => item.key === "turn:written")?.modelRef).toBe("p:first");
      expect(await invoke("task_create", { kind: "content", timeLimitMinutes: 30, instruction: "written", model: "p:first" }, "written")).toMatchObject({
        code: "execution_unknown",
      });
    } finally {
      await manager.stop();
    }
  });
});

async function serviceFixture(taskModels?: string[]) {
  const path = await directory();
  const service = new YesImBotCore({
    baseDir: path,
    config: { basePath: path, chatModel: "test:main", ...(taskModels ? { taskModels } : {}) },
    events: new TestEvents(),
    account: () => testAccount(scope.platform, scope.selfId),
  });
  const models = ["main", "alternate", "worker"].map((id) => ({ id, toolCall: true }));
  const unregister = service.model.register({
    id: "test",
    capabilities: { chat: true, embedding: false },
    chatModels: () => models,
    embeddingModels: () => [],
    chat: () => reportingModel(),
  });
  const channel = { conversation: { currentSessionId: () => "session" }, resources: { imageInput: false, listReaders: () => [] } };
  const internal = service as unknown as { channels: { storedContext: unknown; resolve: unknown } };
  internal.channels.storedContext = vi.fn(async () => scope);
  internal.channels.resolve = vi.fn(async () => channel);
  const host = (service.tasks as unknown as { host: TaskHost }).host;
  const record: TaskRecord = {
    ...origin,
    id: "11111111-1111-4111-8111-111111111111",
    key: "call",
    kind: "content",
    instruction: "work",
    status: "queued",
    createdAt: 0,
    updatedAt: 0,
  };
  return { service, host, record, unregister };
}

describe("Core worker model dispatch", () => {
  it("follows the registered conversation override and ignores a stale override exactly as the main bot does", async () => {
    const { service, host, record } = await serviceFixture();
    await service.overrides.set(scope, { chatModel: "test:alternate" });
    expect(host.modelChoices!({ ...origin, scope })).toEqual(["test:alternate"]);
    const first = await host.prepare({ ...record, modelRef: "test:alternate" }, new AbortController().signal);
    expect((first.config.model as { modelId: string }).modelId).toBe("alternate");
    await first.release?.();
    await service.overrides.set(scope, { chatModel: "test:removed" });
    expect(host.modelChoices!({ ...origin, scope })).toEqual(["test:main"]);
    const legacy = await host.prepare(record, new AbortController().signal);
    expect((legacy.config.model as { modelId: string }).modelId).toBe("main");
    await legacy.release?.();
    await expect(host.prepare({ ...record, modelRef: "test:alternate" }, new AbortController().signal)).rejects.toThrow("task_model_not_allowed");
  });

  it("uses configured workers independently of the chat model, and rejects a missing pinned route before plugin setup", async () => {
    const { service, host, record, unregister } = await serviceFixture(["test:worker", "test:alternate"]);
    const setup = vi.fn(async () => null);
    service.agent.use({ setup });
    expect(host.modelChoices!({ ...origin, scope })).toEqual(["test:worker", "test:alternate"]);
    const configured = await host.prepare(record, new AbortController().signal);
    expect((configured.config.model as { modelId: string }).modelId).toBe("worker");
    await configured.release?.();
    const explicit = await host.prepare({ ...record, modelRef: "test:alternate" }, new AbortController().signal);
    expect((explicit.config.model as { modelId: string }).modelId).toBe("alternate");
    await explicit.release?.();
    const count = setup.mock.calls.length;
    await expect(host.canResumeHandoff!({ ...record, modelRef: "test:main" })).rejects.toThrow("task_model_not_allowed");
    unregister();
    await expect(host.prepare({ ...record, modelRef: "test:worker" }, new AbortController().signal)).rejects.toThrow("task_model_unavailable");
    expect(setup).toHaveBeenCalledTimes(count);
  });

  it("does not share model choices between instances", async () => {
    const first = await serviceFixture(["test:worker"]),
      second = await serviceFixture(["test:alternate"]);
    expect(first.host.modelChoices!({ ...origin, scope })).toEqual(["test:worker"]);
    expect(second.host.modelChoices!({ ...origin, scope })).toEqual(["test:alternate"]);
    await expect(first.host.prepare({ ...first.record, modelRef: "test:alternate" }, new AbortController().signal)).rejects.toThrow("task_model_not_allowed");
  });

  it("rejects an unavailable configured default before task creation instead of switching to the chat model", async () => {
    const { service } = await serviceFixture(["test:removed", "test:worker"]);
    await expect(service.tasks.create({ ...origin, scope }, "content", "work", "missing")).rejects.toThrow("task_model_unavailable");
    expect(await service.tasks.store.list()).toHaveLength(0);
    await service.tasks.stop();
  });
});
