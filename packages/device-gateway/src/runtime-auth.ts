import type { DatabaseSync } from "node:sqlite";

import { uuid } from "@yesimbot/contracts";
import { ensureSchema, openDeviceDatabase, transaction } from "@yesimbot/device-store";
import { hashSecret, newSecret, safeEqual } from "@yesimbot/foundation";

/** A runtime token (32 random bytes, as the runtime manager and the runtimes read it) and its stored hash. */
const HEX_64 = /^[a-f0-9]{64}$/;

/** Scoped machine credentials for runtimes; account cookies never authenticate this service. */
export class RuntimeCredentials {
  private constructor(private readonly db: DatabaseSync) {}
  static async open(directory: string): Promise<RuntimeCredentials> {
    const db = await openDeviceDatabase(directory, "runtimes");
    try {
      ensureSchema(
        db,
        `CREATE TABLE IF NOT EXISTS runtimes (tenant TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS revoked_runtimes (tenant TEXT PRIMARY KEY);`,
      );
      return new RuntimeCredentials(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  provision(tenantId: string): { version: 1; tenantId: string; token: string } {
    uuid.parse(tenantId);
    if (this.db.prepare("SELECT tenant FROM runtimes WHERE tenant = ?").get(tenantId)) throw new Error("runtime_credential_exists");
    const token = newSecret(32, { encoding: "hex" });
    this.ensure(tenantId, token);
    return { version: 1, tenantId, token };
  }
  /** Idempotent recovery: the private file is durable before registering its hash. */
  ensure(tenantId: string, token: string): void {
    uuid.parse(tenantId);
    if (!HEX_64.test(token)) throw new Error("invalid_runtime_token");
    transaction(this.db, () => {
      if (this.db.prepare("SELECT tenant FROM revoked_runtimes WHERE tenant = ?").get(tenantId)) throw new Error("runtime_credential_revoked");
      const row = this.db.prepare("SELECT token_hash FROM runtimes WHERE tenant = ?").get(tenantId);
      const hash = hashSecret(token);
      if (row) {
        if (!safeEqual(String(row.token_hash), hash, { format: HEX_64 })) throw new Error("runtime_credential_mismatch");
        return;
      }
      this.db.prepare("INSERT INTO runtimes VALUES (?, ?)").run(tenantId, hash);
    });
  }

  authenticate(authorization: string | undefined): string | undefined {
    const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization ?? "");
    if (!match) return;
    const hash = hashSecret(match[1]!);
    const row = this.db.prepare("SELECT tenant, token_hash FROM runtimes WHERE token_hash = ?").get(hash);
    if (!row || !safeEqual(String(row.token_hash), hash, { format: HEX_64 })) return;
    return String(row.tenant);
  }
  revoke(tenantId: string): void {
    uuid.parse(tenantId);
    transaction(this.db, () => {
      this.db.prepare("INSERT OR IGNORE INTO revoked_runtimes VALUES (?)").run(tenantId);
      this.db.prepare("DELETE FROM runtimes WHERE tenant = ?").run(tenantId);
    });
  }
  close(): void {
    this.db.close();
  }
}
