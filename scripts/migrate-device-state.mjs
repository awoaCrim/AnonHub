#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
/** Explicit offline, copy-first migration. No ownership guesses and no remote actions. */
import fs from "node:fs/promises";
import { resolve, join, relative, dirname, sep, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { conversationSchema, workspaceOwnerKey, channelStorageDirectory, uuid, opaqueId } from "@yesimbot/contracts";

// The memorizer's table in the state database (plugins/memorizer/src/store/sqlite.ts).
const MEMORY_TABLE = "memorizer_items";
const memoryDigest = (row) => hash(JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))));
const hash = (value) => createHash("sha256").update(value).digest("hex");
function inside(root, path) {
  const child = resolve(root, path),
    rel = relative(root, child);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep) || resolve(child) === resolve(root)) throw Error("path_outside_state");
  return child;
}
async function safePath(root, path) {
  const child = inside(root, path);
  const rel = relative(root, child).split(sep);
  let current = root;
  for (const part of rel) {
    current = join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw Error("linked_state_denied");
  }
  return child;
}
async function files(root) {
  const result = [];
  async function walk(path) {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw Error("linked_state_denied");
    if (stat.isDirectory()) for (const name of (await fs.readdir(path)).sort()) await walk(join(path, name));
    else if (stat.isFile()) result.push(path);
    else throw Error("special_state_file_denied");
  }
  await walk(root);
  return result;
}
export async function treeDigest(root) {
  const digest = createHash("sha256");
  for (const path of await files(root)) {
    digest.update(JSON.stringify(relative(root, path)));
    const file = await fs.open(path, "r");
    try {
      for await (const bytes of file.createReadStream()) digest.update(bytes);
    } finally {
      await file.close();
    }
    digest.update("\0");
  }
  return digest.digest("hex");
}
async function writeNew(path, value) {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await fs.open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function inventory(rootInput, dataPath = "data/yesimbot", databasePath = "data/yesimbot/state.sqlite") {
  const root = await fs.realpath(rootInput),
    data = await safePath(root, dataPath);
  const identity = JSON.parse(await fs.readFile(await safePath(root, join(dataPath, "runtime-identity.json")), "utf8"));
  const tenantId = uuid.parse(identity.tenantId),
    channels = [];
  const directory = join(data, "channels");
  for (const name of await fs.readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    const source = await safePath(root, join(dataPath, "channels", name));
    if (!(await fs.lstat(source)).isDirectory()) continue;
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(join(source, "channel.json"), "utf8"));
    } catch {
      continue;
    }
    channels.push({ source: relative(root, source), digest: await treeDigest(source), manifest });
  }
  let memories = [];
  const database = inside(root, databasePath);
  try {
    await safePath(root, databasePath);
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(MEMORY_TABLE)) {
        memories = db
          .prepare(`SELECT * FROM ${MEMORY_TABLE}`)
          .all()
          .map((row) => ({
            id: row.id,
            scope: row.scope,
            platform: row.platform,
            channelId: row.channel_id,
            selfId: row.self_id,
            userId: row.user_id,
            digest: memoryDigest(row),
          }));
      }
    } finally {
      db.close();
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const workspaces = [];
  for (const channel of channels) {
    const source = join(channel.source, "workspace");
    try {
      const path = await safePath(root, source);
      workspaces.push({ source, digest: await treeDigest(path) });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const workspaceDirectory = join(dataPath, "workspaces");
  for (const name of await fs.readdir(inside(root, workspaceDirectory)).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    const source = join(workspaceDirectory, name),
      path = await safePath(root, source);
    if ((await fs.lstat(path)).isDirectory()) workspaces.push({ source, digest: await treeDigest(path) });
  }
  return { version: 1, tenantId, root, dataPath, databasePath, channels, workspaces, memories, actions: [] };
}
function contextOf(action, tenantId) {
  const c = conversationSchema.parse(action.conversation);
  if (c.tenantId !== tenantId) throw Error("foreign_migration_owner");
  return {
    type: c.kind === "direct" ? "direct" : c.parentId ? "channel" : "guild",
    platform: c.platform,
    channelId: c.conversationId,
    selfId: c.botId,
    ...(c.kind === "direct" ? { userId: opaqueId.parse(action.userId ?? c.conversationId) } : { guildId: c.parentId ?? c.conversationId }),
  };
}
export async function applyMigration(plan, offline) {
  if (!offline || plan.version !== 1 || !Array.isArray(plan.actions) || plan.actions.length > 1000) throw Error("explicit_offline_plan_required");
  const root = await fs.realpath(plan.root),
    data = await safePath(root, plan.dataPath);
  const identity = JSON.parse(await fs.readFile(await safePath(root, join(plan.dataPath, "runtime-identity.json")), "utf8"));
  if (identity.tenantId !== uuid.parse(plan.tenantId)) throw Error("migration_tenant_mismatch");
  const planId = hash(JSON.stringify(plan)),
    receipts = join(data, "migrations", planId);
  await fs.mkdir(receipts, { recursive: true, mode: 0o700 });
  const completed = [];
  for (const [index, action] of plan.actions.entries()) {
    if (!["copy-workspace", "assign-channel", "assign-memory"].includes(action.type)) throw Error("invalid_migration_action");
    const receiptPath = join(receipts, `${index}.json`);
    if (
      await fs.stat(receiptPath).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      )
    ) {
      const receipt = JSON.parse(await fs.readFile(await safePath(root, receiptPath), "utf8"));
      if (receipt.action !== index) throw Error("migration_receipt_mismatch");
      if (action.type === "assign-memory") {
        const db = new DatabaseSync(await safePath(root, plan.databasePath), { readOnly: true });
        try {
          const row = db.prepare(`SELECT * FROM ${MEMORY_TABLE} WHERE id = ?`).get(action.id);
          if (!row || receipt.memoryId !== action.id || memoryDigest(row) !== receipt.digest) throw Error("completed_memory_changed");
        } finally {
          db.close();
        }
      } else if (!receipt.destination || (await treeDigest(await safePath(root, receipt.destination))) !== receipt.digest)
        throw Error("completed_destination_changed");
      completed.push(index);
      continue;
    }
    if (action.type === "assign-memory") {
      const source = plan.memories.find((row) => row.id === action.id);
      if (!source) throw Error("memory_not_in_inventory");
      const file = await safePath(root, plan.databasePath),
        db = new DatabaseSync(file);
      let digest;
      const backupName = `database-${index}-${randomUUID()}.sqlite`;
      try {
        db.exec("PRAGMA busy_timeout=5000");
        const backup = join(receipts, backupName);
        db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
        await fs.chmod(backup, 0o600);
        db.exec("BEGIN IMMEDIATE");
        try {
          const row = db.prepare(`SELECT * FROM ${MEMORY_TABLE} WHERE id = ?`).get(action.id);
          if (!row || memoryDigest(row) !== source.digest) throw Error("memory_changed_since_inventory");
          // A shared memory belongs to the whole instance: there is no conversation to give it.
          if (row.scope === "shared") throw Error("memory_shared_has_no_owner");
          const context = contextOf(action, plan.tenantId);
          if (
            (row.platform && row.platform !== context.platform) ||
            (row.self_id && row.self_id !== context.selfId) ||
            (row.channel_id && row.channel_id !== context.channelId)
          )
            throw Error("memory_owner_conflict");
          if (row.scope === "user" && context.type === "direct" && row.user_id !== context.userId) throw Error("memory_user_conflict");
          // A new revision: an edit made against the old one is refused by the memorizer.
          db.prepare(
            `UPDATE ${MEMORY_TABLE} SET channel_type = ?, platform = ?, guild_id = ?, channel_id = ?, self_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
          ).run(context.type, context.platform, context.guildId ?? null, context.channelId, context.selfId, Date.now(), action.id);
          digest = memoryDigest(db.prepare(`SELECT * FROM ${MEMORY_TABLE} WHERE id = ?`).get(action.id));
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } finally {
        db.close();
      }
      await writeNew(receiptPath, { action: index, memoryId: action.id, backup: backupName, digest });
      completed.push(index);
      continue;
    }
    const source = await safePath(root, action.source);
    const expected = action.type === "assign-channel" ? plan.channels.find((entry) => entry.source === action.source)?.digest : action.digest;
    if (!/^[a-f0-9]{64}$/.test(expected ?? "") || (await treeDigest(source)) !== expected) throw Error("source_changed_since_inventory");
    const context = contextOf(action, plan.tenantId);
    const destination =
      action.type === "assign-channel"
        ? join(data, "channels", channelStorageDirectory(context))
        : join(data, "workspaces", hash(workspaceOwnerKey({ kind: "conversation", conversation: action.conversation })));
    if (
      source === destination ||
      (await fs.stat(destination).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      ))
    )
      throw Error("migration_destination_exists");
    const temporary = destination + "." + randomUUID() + ".tmp";
    try {
      await fs.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await fs.cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
      if ((await treeDigest(source)) !== expected || (await treeDigest(temporary)) !== expected) throw Error("source_changed_during_copy");
      if (action.type === "assign-channel") {
        const manifest = JSON.parse(await fs.readFile(join(temporary, "channel.json"), "utf8"));
        if (manifest.platform !== context.platform || manifest.channelId !== context.channelId || (manifest.selfId && manifest.selfId !== context.selfId))
          throw Error("channel_owner_conflict");
        const botIds = new Set();
        for (const file of (await files(temporary)).filter((path) => path.endsWith(".jsonl"))) {
          const handle = await fs.open(file, "r");
          try {
            for await (const line of handle.readLines()) {
              if (!line.trim()) continue;
              const value = JSON.parse(line);
              const selfId = value.selfId ?? value.data?.selfId;
              const channelId = value.channel?.id ?? value.data?.channel?.id;
              const platform = value.platform ?? value.data?.platform;
              if ((channelId && channelId !== context.channelId) || (platform && platform !== context.platform))
                throw Error("mixed_conversation_history_requires_manual_split");
              if (typeof selfId === "string" && selfId) botIds.add(selfId);
            }
          } finally {
            await handle.close();
          }
        }
        if ([...botIds].some((id) => id !== context.selfId)) throw Error("mixed_bot_history_requires_manual_split");
        if (!manifest.selfId && !botIds.size && action.confirmUnattributed !== true) throw Error("unattributed_history_requires_explicit_confirmation");
        // The user supplies ownership; a manifest already bound to another bot is never reassigned.
        await fs.writeFile(join(temporary, "channel.json"), JSON.stringify({ ...manifest, ...context }) + "\n", { mode: 0o600 });
      }
      await fs.rename(temporary, destination);
      await writeNew(receiptPath, { action: index, source: action.source, destination: relative(root, destination), digest: await treeDigest(destination) });
      completed.push(index);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
  return { completed: completed.length, receipts: relative(root, receipts), sourceDirectoriesPreserved: true };
}
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      data: { type: "string" },
      database: { type: "string" },
      output: { type: "string" },
      plan: { type: "string" },
      offline: { type: "boolean" },
    },
  });
  if (positionals[0] === "inventory" && values.root && values.output)
    await writeNew(resolve(values.output), await inventory(values.root, values.data, values.database));
  else if (positionals[0] === "apply" && values.plan)
    process.stdout.write(JSON.stringify(await applyMigration(JSON.parse(await fs.readFile(values.plan, "utf8")), values.offline)) + "\n");
  else throw Error("usage_inventory_or_apply_offline");
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().catch(() => {
    process.stderr.write("migration_failed; inspect the offline plan and preserved originals\n");
    process.exitCode = 1;
  });
