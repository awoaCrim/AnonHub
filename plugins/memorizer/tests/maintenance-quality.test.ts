import type { AgentTool } from "@yesimbot/agent-runtime";
import { partsFromElements } from "koishi-plugin-yesimbot";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runMaintenance } from "../src/maintainer.js";
import { memoryStore } from "./support.js";

const harness = vi.hoisted(() => ({ run: async (_tools: AgentTool[], _prompt: string) => {} }));
vi.mock("@yesimbot/agent-runtime", () => ({
  jsonSchema: (schema: unknown) => schema,
  createUserMessage: (text: string) => text,
  createAgent: ({ tools }: { tools: AgentTool[] }) => ({
    init: async () => {},
    wait: async () => {},
    stop: async () => {},
    async *run(prompt: string) {
      await harness.run(tools, prompt);
      yield {};
    },
  }),
}));

class Model {
  rows: Record<string, unknown>[] = [];
  extend() {}
  async get(_table: string, query: Record<string, unknown>) {
    return this.rows.filter((row) => Object.entries(query).every(([key, value]) => row[key] === value));
  }
  async create(_table: string, row: Record<string, unknown>) {
    this.rows.push({ ...row });
  }
  async set(table: string, query: Record<string, unknown>, patch: Record<string, unknown>) {
    if ("id" in patch) throw new Error("cannot modify primary key");
    for (const row of await this.get(table, query)) Object.assign(row, patch);
  }
  async remove(table: string, query: Record<string, unknown>) {
    const removed = await this.get(table, query);
    this.rows = this.rows.filter((row) => !removed.includes(row));
  }
}
const context = { type: "direct", platform: "web", selfId: "bot", channelId: "owner", userId: "owner" } as const;
const source = {
  messageId: "native-source-id",
  platform: "web",
  selfId: "bot",
  channel: { id: "owner", type: 1 },
  user: { id: "owner" },
  timestamp: 123,
  parts: partsFromElements(["我长期偏好简洁中文回答"]),
};
const candidate = {
  sourceMessageIds: ["native-source-id"],
  type: "preference",
  content: "主人长期偏好简洁中文回答",
  scope: "user",
  userId: "owner",
  importance: 0.8,
  confidence: 0.9,
  tags: ["偏好"],
};
const execute = (tools: AgentTool[], name: string, input: unknown) => tools.find((tool) => tool.name === name)!.execute(input, {} as never);
const evidence = () => ({ append: vi.fn(async () => {}), read: vi.fn(async () => []), merge: vi.fn(async () => {}), count: vi.fn(async () => 0) });
function setup() {
  const model = new Model();
  const store = memoryStore(model, { tenantId: "11111111-1111-4111-8111-111111111111", isOwner: () => true });
  const files = evidence();
  const run = (messages = [source], allowShared = false) =>
    runMaintenance({ model: {} as never, context, messages: messages as never, store, evidence: files as never, request: "只提炼长期有用事实", allowShared });
  return { model, store, files, run };
}
beforeEach(() => {
  harness.run = async () => {};
});

describe("evidence-backed durable memory maintenance", () => {
  it("retries an interrupted evidence write against the existing canonical record", async () => {
    const { run, files, store } = setup();
    files.append.mockRejectedValueOnce(new Error("disk unavailable"));
    harness.run = async (tools) => {
      await execute(tools, "query_memories", {});
      await execute(tools, "create_memory", candidate);
    };
    await expect(run()).rejects.toThrow("disk unavailable");
    await run();
    expect((await store.listManaged()).memories).toHaveLength(1);
    expect(files.append).toHaveBeenCalledTimes(2);
    expect(files.append.mock.calls[0]![0]).toBe(files.append.mock.calls[1]![0]);
  });

  it("shows actual message IDs, requires prior duplicate lookup, rejects weak/unbacked facts and writes evidence to a canonical ID", async () => {
    const { run, files, store } = setup();
    harness.run = async (tools, prompt) => {
      expect(prompt).toContain('"messageId":"native-source-id"');
      await expect(execute(tools, "create_memory", candidate)).resolves.toMatchObject({ ok: false, error: { code: "memory_duplicate_check_required" } });
      await execute(tools, "query_memories", { query: "中文", semantic: true });
      await expect(execute(tools, "create_memory", { ...candidate, confidence: 0.5 })).resolves.toMatchObject({
        ok: false,
        error: { code: "memory_candidate_weak" },
      });
      await expect(execute(tools, "create_memory", { ...candidate, importance: 0.3 })).resolves.toMatchObject({
        ok: false,
        error: { code: "memory_candidate_weak" },
      });
      await expect(execute(tools, "create_memory", { ...candidate, sourceMessageIds: ["invented"] })).resolves.toMatchObject({
        ok: false,
        error: { code: "memory_source_not_in_batch" },
      });
      await expect(execute(tools, "create_memory", { ...candidate, content: "password=private-secret" })).resolves.toMatchObject({
        ok: false,
        error: { code: "memory_credential" },
      });
      const first = (await execute(tools, "create_memory", candidate)) as { id: string };
      const second = (await execute(tools, "create_memory", { ...candidate, content: ` ${candidate.content} ` })) as { id: string };
      expect(first.id).toBe(second.id);
      await execute(tools, "query_memories", {});
      await expect(execute(tools, "update_memory", { id: first.id, content: "主人长期偏好中文短回答" })).resolves.toMatchObject({
        ok: false,
        error: { code: "memory_batch_evidence_required" },
      });
      await execute(tools, "update_memory", { id: first.id, content: "主人长期偏好中文短回答", sourceMessageIds: [source.messageId] });
    };
    await run();
    expect((await store.listManaged()).memories).toHaveLength(1);
    expect(files.append).toHaveBeenCalledTimes(3);
    expect(new Set(files.append.mock.calls.map(([id]) => id)).size).toBe(1);
  });

  it("excludes whispers/foreign records/credential-bearing evidence and never publishes private-source creates or updates", async () => {
    const { run, store, files } = setup();
    const shared = await store.create({
      type: "knowledge",
      content: "公开的通用开发约定",
      scope: "shared",
      platform: "onebot",
      importance: 0.8,
      confidence: 0.9,
      tags: [],
    });
    harness.run = async (tools, prompt) => {
      expect(prompt).not.toContain("PRIVATE-WHISPER");
      expect(prompt).not.toContain("OTHER-PLATFORM");
      expect(prompt).not.toContain("private-secret");
      await execute(tools, "query_memories", {});
      await expect(execute(tools, "create_memory", { ...candidate, scope: "shared", userId: undefined, content: "通用开发流程" })).resolves.toMatchObject({
        ok: false,
        error: { code: "memory_shared_not_requested" },
      });
      await expect(execute(tools, "update_memory", { id: shared.id, content: "私人流程", sourceMessageIds: [source.messageId] })).resolves.toMatchObject({
        ok: false,
        error: { code: "memory_shared_not_requested" },
      });
      await expect(execute(tools, "create_memory", { ...candidate, sourceMessageIds: ["whisper"] })).resolves.toMatchObject({
        ok: false,
        error: { code: "memory_source_not_in_batch" },
      });
    };
    await run(
      [
        source,
        { ...source, messageId: "whisper", whisper: true, parts: partsFromElements(["PRIVATE-WHISPER"]) } as never,
        { ...source, messageId: "foreign", platform: "onebot", parts: partsFromElements(["OTHER-PLATFORM"]) },
        { ...source, messageId: "secret", parts: partsFromElements(["password=private-secret"]) },
      ],
      true,
    );
    expect(files.append).not.toHaveBeenCalled();
    expect((await store.get(shared.id))?.content).toBe("公开的通用开发约定");
  });
});
