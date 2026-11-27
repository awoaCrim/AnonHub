import type { DatabaseSync } from "node:sqlite";

import { ensureSchema, openDeviceDatabase, transaction } from "./database.js";
import { fingerprintValue } from "./operations.js";

/** Opaque native resource handles are immutably bound to the conversation that issued them. */
export class ResourceBindings {
  private constructor(private readonly db: DatabaseSync) {}
  static async open(directory: string): Promise<ResourceBindings> {
    const db = await openDeviceDatabase(directory, "resources");
    try {
      ensureSchema(db, "CREATE TABLE IF NOT EXISTS resources (token TEXT PRIMARY KEY, owner TEXT NOT NULL);");
      return new ResourceBindings(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  bind(token: string, owner: unknown): void {
    transaction(this.db, () => {
      const value = fingerprintValue(owner),
        existing = this.db.prepare("SELECT owner FROM resources WHERE token = ?").get(token);
      if (existing) {
        if (existing.owner !== value) throw new Error("resource_binding_conflict");
        return;
      }
      if (Number(this.db.prepare("SELECT COUNT(*) n FROM resources").get()?.n) >= 1_000_000) throw new Error("resource_binding_capacity");
      this.db.prepare("INSERT INTO resources VALUES (?, ?)").run(token, value);
    });
  }
  allows(token: string, owner: unknown): boolean {
    return this.db.prepare("SELECT owner FROM resources WHERE token = ?").get(token)?.owner === fingerprintValue(owner);
  }
  close(): void {
    this.db.close();
  }
}
