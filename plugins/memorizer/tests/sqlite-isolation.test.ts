import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeStateDb, configureStorage } from "@yesimbot/foundation";
import { partsFromElements } from "koishi-plugin-yesimbot";
import { expect, it } from "vitest";

import { EvidenceStore } from "../src/store/evidence.js";
import { sqliteMemoryTable } from "../src/store/sqlite.js";
import { sqliteStore } from "./support.js";

it("persists one tenant library across trusted owner ingress while keeping groups and evidence private", async () => {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-library-sqlite-"));
  configureStorage({ dataRoot: root });
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const web = { type: "direct" as const, platform: "web", selfId: "bot", channelId: "owner", userId: "owner" };
  const qq = { type: "direct" as const, platform: "onebot", selfId: "qqbot", channelId: "private:123", userId: "123" };
  const group = { type: "guild" as const, platform: "onebot", selfId: "qqbot", channelId: "room", guildId: "room" };
  const store = sqliteStore(sqliteMemoryTable(), {
    tenantId,
    isOwner: (scope) =>
      scope.type === "direct" && ((scope.platform === "web" && scope.userId === "owner") || (scope.platform === "onebot" && scope.userId === "123")),
  });
  const evidence = new EvidenceStore(root);
  const fact = { type: "preference" as const, content: "owner prefers concise Chinese", importance: 0.8, confidence: 0.9, tags: [] };
  try {
    const privateMemory = await store.create({ ...fact, scope: "user", context: web, platform: "web", userId: "owner" });
    const shared = await store.create({ ...fact, type: "knowledge", content: "run relevant tests after edits", scope: "shared", platform: "onebot" });
    const raw = {
      platform: "web",
      selfId: "bot",
      channel: { id: "owner", type: 1 },
      user: { id: "owner" },
      messageId: "source",
      timestamp: 1,
      parts: partsFromElements([]),
    };
    await evidence.append(privateMemory.id, [raw]);
    expect((await store.queryVisible(qq, ["123"])).map((entry) => entry.id).sort()).toEqual([privateMemory.id, shared.id].sort());
    expect((await store.queryVisible(group, ["123", "owner"])).map((entry) => entry.id)).toEqual([shared.id]);
    expect(await store.visibleEvidence(privateMemory, group, ["123"], await evidence.read(privateMemory.id))).toEqual([]);
    expect(await store.visibleEvidence(privateMemory, qq, ["123"], await evidence.read(privateMemory.id))).toEqual([raw]);
    const edited = await store.editManaged({ id: privateMemory.id, revision: 1, content: "owner prefers concise answers", visibility: "owner" });
    expect(edited.revision).toBe(2);
    await expect(store.editManaged({ id: privateMemory.id, revision: 1, content: "stale", visibility: "shared" })).rejects.toThrow("memory_revision_conflict");
    await store.deleteManaged({ id: privateMemory.id, revision: 2 }, (id) => evidence.remove(id));
    expect(await store.get(privateMemory.id)).toBeUndefined();
    expect(await evidence.read(privateMemory.id)).toEqual([]);
  } finally {
    closeStateDb();
    await rm(root, { recursive: true, force: true });
  }
});

it("persists owned memory and keeps another tenant out in real SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-memory-sqlite-"));
  configureStorage({ dataRoot: root });
  const store = sqliteStore(sqliteMemoryTable());
  const scope = { type: "direct" as const, platform: "test", selfId: "bot", channelId: "alice", userId: "alice" };
  const input = { type: "fact" as const, content: "private coffee", importance: 0.8, confidence: 1, tags: [] };
  try {
    await store.create({ ...input, scope: "user", context: scope, platform: "test", userId: "alice" }, "private");
    await store.create({ ...input, content: "shared knowledge", scope: "shared", platform: "test" }, "shared");
    expect((await store.queryVisible(scope, ["alice"])).map((row) => row.id).sort()).toEqual(["private", "shared"]);
    const group = { type: "guild" as const, platform: "test", selfId: "bot", guildId: "room", channelId: "room" };
    expect((await store.queryVisible(group, ["alice"])).map((row) => row.id)).toEqual(["shared"]);
    const isolated = sqliteStore(sqliteMemoryTable(), { tenantId: "22222222-2222-4222-8222-222222222222" });
    expect(await isolated.queryVisible(group, ["alice"])).toEqual([]);
    await store.update("private", { content: "updated private" });
    await store.forget("private", "test");
    await store.restore("private");
    expect(await store.get("private")).toMatchObject({ id: "private", content: "updated private", selfId: "bot", channelId: "alice", status: "active" });
    expect(await store.get("shared")).toMatchObject({ visibility: "shared" });
  } finally {
    closeStateDb();
    await rm(root, { recursive: true, force: true });
  }
});
