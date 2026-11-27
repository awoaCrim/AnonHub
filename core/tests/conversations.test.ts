import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEntry } from "@yesimbot/agent-runtime";
import { partsFromElements } from "@yesimbot/contracts/parts";
import { afterEach, describe, expect, it } from "vitest";

import { Conversation } from "../src/conversations/index.js";
import { createMessage, type MessageRecord } from "../src/messages/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

// ---------------------------------------------------------------------------
// Conversation.archive
// ---------------------------------------------------------------------------

describe("Conversation.archive", () => {
  it("switches active storage to a fresh session", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-archive-"));
    roots.push(root);
    const conversation = new Conversation(root);
    await conversation.init();
    await conversation.storage.append(createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "hello" }));

    await conversation.archive(true);

    expect(await conversation.storage.read()).toEqual([]);
    expect(await conversation.list()).toHaveLength(2);
  });
  it("rejects archiving an empty session without creating a destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-archive-"));
    roots.push(root);
    const conversation = new Conversation(root);
    await conversation.init();
    const before = await conversation.list();
    await expect(conversation.archive(true)).rejects.toThrow("conversation_empty");
    expect(await conversation.list()).toEqual(before);
  });

  it("creates a blank destination when noSummary is explicit", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-archive-"));
    roots.push(root);
    const conversation = new Conversation(root);
    await conversation.init();
    await conversation.storage.append(createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "hello" }));
    await conversation.archive(true);
    expect(await conversation.storage.read()).toEqual([]);
    expect((await conversation.list()).filter((item) => item.isActive)).toHaveLength(1);
  });
});

describe("Conversation archiving policies", () => {
  it("keeps the storage facade on the new active file after archiving", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-storage-facade-"));
    roots.push(root);
    const conversation = new Conversation(root);
    await conversation.init();
    const storage = conversation.storage;
    await storage.append(createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "hello" }));

    await conversation.archive(true);

    expect(await storage.read()).toEqual([]);
  });

  it("keeps an oversized file while no region covers any of its records", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-size-archive-"));
    roots.push(root);
    const conversation = new Conversation(root);
    await conversation.init();
    await conversation.storage.append(createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "x".repeat(1000) }));

    await expect(conversation.archiveIfOversize(10_000)).resolves.toBe(false);
    await expect(conversation.archiveIfOversize(1)).resolves.toBe(false);
    expect(await conversation.list()).toHaveLength(1);
    expect(await conversation.storage.read()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Conversation.read
// ---------------------------------------------------------------------------

function record(messageId: string, timestamp: number, userId = "user-1"): MessageRecord {
  return {
    platform: "test",
    selfId: "bot-1",
    timestamp,
    channel: { id: "room-1", type: 0 },
    user: { id: userId, name: userId },
    messageId,
    parts: partsFromElements([]),
  };
}

describe("Conversation.read", () => {
  it("reads platform messages across active and archived sessions in chronological source windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-read-"));
    roots.push(root);
    const conversation = new Conversation(root);
    await conversation.init();
    await conversation.storage.append(
      createEntry("message", createMessage(record("first", 1))),
      createEntry("message", { id: "assistant", timestamp: 2, role: "assistant", content: "ignored" }),
      createEntry("event", { type: "started", turnId: "turn" }),
      createEntry("message", createMessage(record("source", 3, "user-2"))),
    );
    await conversation.archive(true);
    await conversation.storage.append(createEntry("message", createMessage(record("last", 4))));

    await expect(conversation.read({ messageIds: ["source", "last"], before: 1, after: 1, userIds: ["user-1", "user-2"] })).resolves.toMatchObject([
      { messageId: "first" },
      { messageId: "source" },
      { messageId: "last" },
    ]);
  });

  it("limits source windows without dropping sources and uses newest entries without sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-read-limit-"));
    roots.push(root);
    const conversation = new Conversation(root);
    await conversation.init();
    await conversation.storage.append(
      createEntry("message", createMessage(record("one", 1))),
      createEntry("message", createMessage(record("two", 2))),
      createEntry("message", createMessage(record("three", 3))),
    );

    await expect(conversation.read({ messageIds: ["one", "three"], before: 1, after: 1, limit: 1 })).resolves.toMatchObject([
      { messageId: "one" },
      { messageId: "three" },
    ]);
    await expect(conversation.read({ limit: 2 })).resolves.toMatchObject([{ messageId: "two" }, { messageId: "three" }]);
  });
  it("rejects missing and duplicate source ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-read-errors-"));
    roots.push(root);
    const conversation = new Conversation(root);
    await conversation.init();
    await conversation.storage.append(createEntry("message", createMessage(record("duplicate", 1))));
    await conversation.archive(true);
    await conversation.storage.append(createEntry("message", createMessage(record("duplicate", 2))));

    await expect(conversation.read({ messageIds: ["missing"] })).rejects.toMatchObject({
      code: "conversation_source_message_invalid",
      detail: "missing missing",
    });
    await expect(conversation.read({ messageIds: ["duplicate"] })).rejects.toMatchObject({
      code: "conversation_source_message_invalid",
      detail: "duplicate duplicated",
    });
  });
});
