import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEntry, type AgentEntry } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it } from "vitest";

import { ContextBlockStore, contextRegionSource, safeSourceRecords, type ContextSourceSnapshot } from "../src/conversations/context-blocks.js";
import type { ContextRegionDraft } from "../src/conversations/historian.js";
import { Conversation } from "../src/conversations/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const draft: ContextRegionDraft = {
  tiers: { P1: "detailed historical banana facts", P2: "historical kiwi facts", P3: "pear fact", P4: "anchor" },
  importance: 0.7,
};

async function regionFixture(entries: readonly AgentEntry[], ids: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-context-source-"));
  roots.push(root);
  const conversation = new Conversation(root);
  await conversation.init();
  await conversation.storage.append(...entries);
  const region = await conversation.commitContextRegion(await conversation.freezeContextRegion(ids), draft);
  return { conversation, region, store: new ContextBlockStore(() => conversation.contextSources()) };
}

const user = (id: string, text = id): AgentEntry => createEntry("message", { id, timestamp: 1, role: "user", content: text }, { id, timestamp: 1 });
function snapshot(active: readonly AgentEntry[], sessions: Record<string, readonly AgentEntry[]> = { source: active }): ContextSourceSnapshot {
  return {
    sessionId: "source",
    entries: active,
    sessionIds: Object.keys(sessions),
    readSession: async (id) => sessions[id] ?? [],
  };
}

function speech(id: string, messages: string[], proof?: Record<string, unknown>): AgentEntry[] {
  return [
    createEntry(
      "message",
      {
        id: `${id}_call`,
        timestamp: 1,
        role: "assistant",
        content: [
          { type: "text", text: "PRIVATE assistant text" },
          { type: "reasoning", text: "PRIVATE reasoning" },
          { type: "tool-call", toolCallId: id, toolName: "send_message", input: { messages } },
        ],
      },
      { id: `${id}_call`, timestamp: 1 },
    ),
    ...(proof
      ? [
          createEntry(
            "message",
            {
              id: `${id}_result`,
              timestamp: 2,
              role: "tool",
              content: [{ type: "tool-result", toolCallId: id, toolName: "send_message", output: { type: "json", value: proof } }],
            },
            { id: `${id}_result`, timestamp: 2 },
          ),
        ]
      : []),
  ];
}

describe("verified source catalogue and pagination", () => {
  it("builds bounded searchable raw blocks without a region or model and excludes the active turn", async () => {
    const entries = Array.from({ length: 35 }, (_, i) => user(`u${i}`, `history${i} banana`));
    const store = new ContextBlockStore(async () => snapshot(entries));
    const first = await store.list({ limit: 20 }, new Set(["u34"]));
    expect(first.blocks).toHaveLength(20);
    expect(first.nextCursor).toBeDefined();
    const next = await store.list({ limit: 20, cursor: first.nextCursor }, new Set(["u34"]));
    expect(next.blocks).toHaveLength(14);
    expect(new Set([...first.blocks, ...next.blocks].map((block) => block.id)).size).toBe(34);
    expect((await store.list({ query: "not found" })).blocks).toEqual([]);
    expect((await store.list({ query: "banana" })).blocks).toHaveLength(10);
    await expect(store.list({ cursor: "forged" })).rejects.toThrow("context_cursor_invalid");
    await expect(store.list({ limit: 21 })).rejects.toThrow("context_limit_invalid");
    expect(first.blocks.every((block) => Buffer.byteLength(block.summary!, "utf8") <= 400)).toBe(true);
  });
  it("paginates 60 records and long multibyte text without gaps or changing the source", async () => {
    const text = "🙂中<&>".repeat(1000);
    const raw = [user("u1", text), ...Array.from({ length: 59 }, (_, i) => user(`middle${i}`, `record${i}`)), user("u2")];
    const { conversation, region, store } = await regionFixture(
      raw,
      raw.map((entry) => entry.id),
    );
    const before = JSON.stringify(await conversation.storage.read());
    const rendered: string[] = [];
    const recordIds = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await store.page({ blockId: region.id, cursor }, 1024);
      expect(page.records.length).toBeLessThanOrEqual(50);
      expect(page.records.length).toBeGreaterThan(0);
      for (const record of page.records) {
        recordIds.add(record.entryId);
        if (record.entryId === "u1") rendered.push(record.text);
      }
      expect(page.nextCursor).not.toBe(cursor);
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 200);
    expect(cursor).toBeUndefined();
    expect(pages).toBeGreaterThan(2);
    expect(rendered.join("")).toBe(text);
    expect(recordIds.size).toBe(61);
    expect(JSON.stringify(await conversation.storage.read())).toBe(before);
    const large = await store.page({ blockId: region.id }, 100_000);
    expect(large.records).toHaveLength(50);
    expect(large.nextCursor).toBeDefined();
  });
  it("rejects cross-block, forged and source-changed cursors", async () => {
    let entries = [user("u1", "x".repeat(3000)), user("u2", "y".repeat(3000))];
    const store = new ContextBlockStore(async () => snapshot(entries));
    const blocks = (await store.list({})).blocks;
    const page = await store.page({ blockId: blocks[0]!.id }, 512);
    await expect(store.page({ blockId: blocks[1]!.id, cursor: page.nextCursor }, 512)).rejects.toThrow("context_cursor_invalid");
    await expect(store.page({ blockId: blocks[0]!.id, cursor: "forged" }, 512)).rejects.toThrow("context_cursor_invalid");
    entries = entries.map((entry) => (entry.id === blocks[0]!.firstEntryId ? user(entry.id, "changed") : entry));
    await expect(store.page({ blockId: blocks[0]!.id, cursor: page.nextCursor }, 512)).rejects.toThrow("context_cursor_invalid");
  });
  it("rejects a late archive-body read after invalidation and does not restore old cursors", async () => {
    const { conversation, region } = await regionFixture([user("u1", "x".repeat(3000)), user("u2")], ["u1", "u2"]);
    await conversation.archive();
    let blocked = false;
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new ContextBlockStore(async () => {
      const base = await conversation.contextSources();
      return {
        ...base,
        readSession: async (id) => {
          if (blocked) {
            entered();
            await gate;
          }
          return base.readSession(id);
        },
      };
    });
    const first = await store.page({ blockId: region.id }, 512);
    blocked = true;
    const pending = store.page({ blockId: region.id, cursor: first.nextCursor }, 512);
    await ready;
    store.invalidate();
    release();
    await expect(pending).rejects.toThrow("context_read_stale");
    blocked = false;
    await expect(store.page({ blockId: region.id, cursor: first.nextCursor }, 512)).rejects.toThrow("context_cursor_invalid");
  });
  it("invalidates pagination when delivery evidence outside the region range changes", async () => {
    const spoken = speech("send", ["public".repeat(1000)], { ok: true, count: 1, messageIds: ["id"] });
    const { conversation, region } = await regionFixture(spoken, ["send_call"]);
    let swapped = false;
    const store = new ContextBlockStore(async () => {
      const base = await conversation.contextSources();
      if (!swapped) return base;
      return { ...base, entries: [spoken[0]!, ...speech("send", [], { ok: false, sent: [], failedAt: 0 }).slice(1)] };
    });
    const page = await store.page({ blockId: region.id }, 512);
    expect(page.omittedEntries).toBe(0);
    expect(page.nextCursor).toBeDefined();
    swapped = true;
    await expect(store.page({ blockId: region.id, cursor: page.nextCursor }, 512)).rejects.toThrow();
  });
});

describe("public source records", () => {
  it("preserves user indentation and array text while replacing media with inert labels", () => {
    const text = "  indented code\n  next line  ";
    const array = createEntry(
      "message",
      {
        id: "array",
        timestamp: 1,
        role: "user",
        content: [
          { type: "text", text },
          { type: "image", image: "PRIVATE payload", mediaType: "image/png" },
        ],
      },
      { id: "array", timestamp: 1 },
    );
    const records = safeSourceRecords([user("u", text), array]);
    expect(records.map((record) => record.text)).toEqual([text, text + "[图片]"]);
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
  });
  it("treats event text as public source so event-driven channels can be summarized", () => {
    const event = (id: string, text: string): AgentEntry =>
      createEntry("message", { id, timestamp: 5, role: "custom", type: "yesimbot.event", data: { eventType: "xiaoheihe.browse", text } }, { id, timestamp: 5 });
    const tool = createEntry(
      "message",
      {
        id: "tool",
        timestamp: 6,
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "t", toolName: "xiaoheihe", output: { type: "json", value: "PRIVATE tool body" } }],
      },
      { id: "tool", timestamp: 6 },
    );
    const entries = [event("e1", "浏览时段：帖子 A"), tool, event("e2", "浏览时段：帖子 B")];
    const records = safeSourceRecords(entries);
    expect(records).toEqual([
      { entryId: "e1", timestamp: 5, role: "event", text: "浏览时段：帖子 A" },
      { entryId: "e2", timestamp: 5, role: "event", text: "浏览时段：帖子 B" },
    ]);
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
    // Before, a batch of only events and tool pairs had no records and was always unavailable.
    expect(contextRegionSource(entries, ["e1", "tool", "e2"]).records).toHaveLength(2);
  });
  it("omits private assistant/system/tool text, failed or unproven sends and temporary media", () => {
    const entries = [
      user("u1", "user public"),
      createEntry("message", { id: "system", timestamp: 1, role: "system", content: "PRIVATE system" }),
      ...speech("ok", ["public<inner_thought>PRIVATE thought</inner_thought><img src='artifact://secret'/>"], { ok: true, count: 1, messageIds: ["id"] }),
      ...speech("failed", ["PRIVATE failed"], { ok: false, sent: [], failedAt: 0 }),
      ...speech("unknown", ["PRIVATE unproven"]),
    ];
    const records = safeSourceRecords(entries);
    const text = JSON.stringify(records);
    expect(text).toContain("user public");
    expect(text).toContain("public[图片]");
    expect(text).not.toContain("PRIVATE");
    expect(text).not.toContain("artifact://");
    expect(records).toHaveLength(2);
  });
  it("uses successful input count and completed partial boundary, not platform ID count as a message index", () => {
    const records = safeSourceRecords([
      ...speech("ok", ["a", "b"], { ok: true, count: 2, messageIds: ["one", "two", "three"] }),
      ...speech("partial", ["c", "d", "PRIVATE failed"], { ok: false, sent: ["one", "two", "extra-segment"], failedAt: 2 }),
    ]);
    expect(records.map((record) => record.text)).toEqual(["a", "b", "c", "d"]);
  });
  it("does not let sanitization shift a partial proof onto an unproven message", () => {
    const records = safeSourceRecords(
      speech("partial", ["<inner_thought>PRIVATE</inner_thought>", "public completed", "PRIVATE failed"], { ok: false, sent: ["one", "two"], failedAt: 2 }),
    );
    expect(records.map((record) => record.text)).toEqual(["public completed"]);
  });
  it.each([
    { ok: true, count: 0 },
    { ok: true, count: 1 },
    { ok: false, sent: ["id"], failedAt: 2 },
    { ok: true, count: 1, messageIds: [] },
    { ok: true, count: 9 },
    { ok: false, sent: ["id"], failedAt: 0 },
    { ok: false, sent: ["id"], failedAt: 9 },
    { ok: false, sent: ["id"], failedAt: 1 },
  ])("denies malformed or zero delivery evidence %j", (proof) => {
    expect(safeSourceRecords(speech("bad", ["PRIVATE uncertain"], proof))).toEqual([]);
  });
  it("does not trust a receipt before its call or malformed control markup", () => {
    const entries = speech("reversed", ["PRIVATE future"], { ok: true, count: 1, messageIds: ["id"] });
    expect(safeSourceRecords([...entries].reverse())).toEqual([]);
    expect(safeSourceRecords(speech("markup", ["<inner_thought>PRIVATE unclosed"], { ok: true, count: 1, messageIds: ["id"] }))).toEqual([]);
    expect(safeSourceRecords(speech("ids", ["PRIVATE malformed"], { ok: true, messageIds: [null] }))).toEqual([]);
    expect(safeSourceRecords(speech("count", ["PRIVATE malformed"], { ok: true, count: -1, messageIds: ["id"] }))).toEqual([]);
  });
  it("denies duplicate calls or receipts instead of picking one", () => {
    const entries = speech("duplicate", ["PRIVATE duplicate"], { ok: true, count: 1, messageIds: ["id"] });
    expect(safeSourceRecords([...entries, entries[0]!])).toEqual([]);
    expect(safeSourceRecords([...entries, entries[1]!])).toEqual([]);
  });
});
