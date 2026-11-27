import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { inventory, applyMigration } from "../migrate-device-state.mjs";
const tenantId = "11111111-1111-4111-8111-111111111111";
const conversation = { tenantId, platform: "test", botId: "bot", kind: "group", conversationId: "room" };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const channel = join(root, "data/yesimbot/channels/test-room");
  await mkdir(join(channel, "workspace"), { recursive: true });
  await writeFile(join(root, "data/yesimbot/runtime-identity.json"), JSON.stringify({ version: 1, tenantId }));
  await writeFile(join(channel, "channel.json"), JSON.stringify({ type: "guild", platform: "test", channelId: "room", guildId: "room" }));
  await writeFile(join(channel, "workspace/file.txt"), "private contents");
  return { root, channel };
}
test("requires explicit offline ownership, preserves originals and verifies completed copies", async (t) => {
  const { root, channel } = await fixture(t),
    plan = await inventory(root);
  plan.actions.push({ type: "assign-channel", source: plan.channels[0].source, conversation, confirmUnattributed: true });
  plan.actions.push({ type: "copy-workspace", ...plan.workspaces[0], conversation });
  await assert.rejects(applyMigration(plan, false), /offline/);
  const result = await applyMigration(plan, true);
  assert.equal(result.completed, 2);
  assert.equal(await readFile(join(channel, "workspace/file.txt"), "utf8"), "private contents");
  assert.equal((await applyMigration(plan, true)).completed, 2);
  const receipt = JSON.parse(await readFile(join(root, result.receipts, "1.json"), "utf8"));
  await writeFile(join(root, receipt.destination, "file.txt"), "modified");
  await assert.rejects(applyMigration(plan, true), /completed_destination_changed/);
});
test("refuses ambiguous, changed, foreign and mixed-bot history", async (t) => {
  const { root, channel } = await fixture(t);
  const plan = await inventory(root);
  plan.actions.push({ type: "assign-channel", source: plan.channels[0].source, conversation });
  await assert.rejects(applyMigration(plan, true), /unattributed/);
  plan.actions[0].conversation = { ...conversation, tenantId: "22222222-2222-4222-8222-222222222222" };
  await assert.rejects(applyMigration(plan, true), /foreign/);
  await writeFile(join(channel, "history.jsonl"), JSON.stringify({ selfId: "different-bot" }) + "\n");
  plan.actions[0].conversation = conversation;
  await assert.rejects(applyMigration(plan, true), /changed_since/);
  const latest = await inventory(root);
  latest.actions = plan.actions;
  await assert.rejects(applyMigration(latest, true), /mixed_bot/);
});
test("refuses linked input and linked runtime identity", async (t) => {
  const { root, channel } = await fixture(t),
    plan = await inventory(root);
  await symlink("file.txt", join(channel, "workspace/link"));
  await assert.rejects(inventory(root), /linked_state/);
  const identity = join(root, "data/yesimbot/runtime-identity.json");
  await rm(identity);
  await writeFile(join(root, "identity.json"), JSON.stringify({ tenantId }));
  await symlink(join(root, "identity.json"), identity);
  await assert.rejects(applyMigration(plan, true), /linked_state/);
});
test("backs up memory, assigns only the named row and validates a resumed plan", async (t) => {
  const { root } = await fixture(t),
    file = join(root, "data/yesimbot/state.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE memorizer_items(id TEXT PRIMARY KEY, scope TEXT, platform TEXT, channel_type TEXT, guild_id TEXT, channel_id TEXT, self_id TEXT, user_id TEXT, revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER, content TEXT); INSERT INTO memorizer_items(id, scope, platform, content) VALUES('one','channel','test','private'); INSERT INTO memorizer_items(id, scope, platform, content) VALUES('two','channel','test','untouched'); INSERT INTO memorizer_items(id, scope, platform, content) VALUES('three','shared','test','instance')",
  );
  db.close();
  const plan = await inventory(root);
  assert.equal(JSON.stringify(plan.memories).includes("private"), false);
  await assert.rejects(applyMigration({ ...plan, actions: [{ type: "assign-memory", id: "three", conversation }] }, true), /memory_shared_has_no_owner/);
  plan.actions.push({ type: "assign-memory", id: "one", conversation });
  const result = await applyMigration(plan, true);
  assert.equal((await applyMigration(plan, true)).completed, 1);
  const receipt = JSON.parse(await readFile(join(root, result.receipts, "0.json"), "utf8"));
  const before = new DatabaseSync(join(root, result.receipts, receipt.backup), { readOnly: true });
  assert.equal(before.prepare("SELECT content FROM memorizer_items WHERE id='one'").get().content, "private");
  before.close();
  const after = new DatabaseSync(file);
  assert.equal(after.prepare("SELECT channel_id FROM memorizer_items WHERE id='two'").get().channel_id, null);
  assert.deepEqual(
    { ...after.prepare("SELECT channel_type, channel_id, self_id, revision FROM memorizer_items WHERE id='one'").get() },
    { channel_type: "guild", channel_id: "room", self_id: "bot", revision: 1 },
  );
  after.exec("UPDATE memorizer_items SET content='changed' WHERE id='one'");
  after.close();
  await assert.rejects(applyMigration(plan, true), /completed_memory_changed/);
});
