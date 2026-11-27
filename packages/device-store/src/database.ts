import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { resolveInside } from "@yesimbot/foundation";

/** Private, crash-safe local state. SQLite owns locking; a crash leaves no stale application lock. */
export async function openDeviceDatabase(directory: string, name: string): Promise<DatabaseSync> {
  if (!/^[a-z-]+$/.test(name)) throw new Error("invalid_database_name");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe_state_directory");
  if (process.platform !== "win32") {
    if (info.uid !== process.getuid?.()) throw new Error("foreign_state_directory");
    await chmod(directory, 0o700);
  }
  const path = await resolveInside(directory, name + ".sqlite", { links: "reject", allowMissing: true });
  try {
    const file = await open(path, "wx", 0o600);
    await file.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      const metadata = await lstat(path + suffix);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (process.platform !== "win32" && metadata.uid !== process.getuid?.()))
        throw new Error("unsafe_state_file");
      if (process.platform !== "win32") await chmod(path + suffix, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = operation();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Creates what is missing; `sql` is `CREATE … IF NOT EXISTS` statements. The data carries no version (convention 08):
 * a change of format is a one-time script, never a migration here.
 */
export function ensureSchema(db: DatabaseSync, sql: string): void {
  transaction(db, () => db.exec(sql));
}
