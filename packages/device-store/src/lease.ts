import type { DatabaseSync } from "node:sqlite";

import { openDeviceDatabase } from "./database.js";

/** SQLite holds the process lease; crashes release it without stale PID files or PID reuse. */
export class DeviceProcessLease {
  private constructor(private readonly db: DatabaseSync) {}
  static async acquire(directory: string): Promise<DeviceProcessLease> {
    const db = await openDeviceDatabase(directory, "process-lease");
    try {
      db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
      return new DeviceProcessLease(db);
    } catch {
      db.close();
      throw new Error("device_client_already_running");
    }
  }
  close(): void {
    this.db.close();
  }
}
