import type { DatabaseSync } from "node:sqlite";

import { deviceRecordSchema, enrollmentSchema, uuid, type DeviceCredential, type DeviceEnrollment, type DeviceRecord } from "@yesimbot/contracts";
import { ensureSchema, openDeviceDatabase, transaction } from "@yesimbot/device-store";
import { type Clock, hashSecret, newId, newSecret, safeEqual, systemClock } from "@yesimbot/foundation";

/** A device secret and a stored hash: 32 bytes, hex. */
const HEX_64 = /^[a-f0-9]{64}$/;

/** Only credential hashes are stored. Pairing and enrollment commit atomically. */
export class DeviceRegistry {
  private closed = false;
  private constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  static async open(directory: string, clock: Clock = systemClock()): Promise<DeviceRegistry> {
    const db = await openDeviceDatabase(directory, "devices");
    try {
      ensureSchema(
        db,
        `
        CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, record TEXT NOT NULL, credential_hash TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS devices_tenant ON devices(tenant);
        CREATE TABLE IF NOT EXISTS pairings (hash TEXT PRIMARY KEY, tenant TEXT NOT NULL, expires INTEGER NOT NULL);
      `,
      );
      return new DeviceRegistry(db, clock);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  createPairing(tenantId: string): { code: string; expiresAt: number } {
    uuid.parse(tenantId);
    this.assertOpen();
    return transaction(this.db, () => {
      this.db.prepare("DELETE FROM pairings WHERE expires <= ?").run(this.clock.now());
      if (Number(this.db.prepare("SELECT COUNT(*) n FROM pairings").get()?.n) >= 1000) throw new Error("pairing_capacity");
      const code = newSecret(24, { encoding: "hex" }),
        expiresAt = this.clock.now() + 5 * 60_000;
      this.db.prepare("INSERT INTO pairings VALUES (?, ?, ?)").run(hashSecret(code), tenantId, expiresAt);
      return { code, expiresAt };
    });
  }

  async enroll(input: DeviceEnrollment): Promise<{ credential: DeviceCredential; device: DeviceRecord }> {
    const value = enrollmentSchema.parse(input);
    this.assertOpen();
    return transaction(this.db, () => {
      const key = hashSecret(value.code);
      const pairing = this.db.prepare("SELECT tenant, expires FROM pairings WHERE hash = ?").get(key);
      if (!pairing || Number(pairing.expires) <= this.clock.now()) throw new Error("invalid_pairing");
      if (Number(this.db.prepare("SELECT COUNT(*) n FROM devices").get()?.n) >= 10_000) throw new Error("device_capacity");
      const credential: DeviceCredential = { version: 1, tenantId: String(pairing.tenant), deviceId: newId(), secret: newSecret(32, { encoding: "hex" }) };
      const device: DeviceRecord = {
        deviceId: credential.deviceId,
        tenantId: credential.tenantId,
        name: value.name,
        platform: value.platform,
        capabilities: value.capabilities,
        createdAt: this.clock.now(),
      };
      this.db.prepare("DELETE FROM pairings WHERE hash = ?").run(key);
      this.db.prepare("INSERT INTO devices VALUES (?, ?, ?, ?)").run(device.deviceId, device.tenantId, JSON.stringify(device), hashSecret(credential.secret));
      return { credential, device };
    });
  }

  list(tenantId: string): DeviceRecord[] {
    uuid.parse(tenantId);
    this.assertOpen();
    return this.db
      .prepare("SELECT record FROM devices WHERE tenant = ? ORDER BY id")
      .all(tenantId)
      .map((row) => deviceRecordSchema.parse(JSON.parse(String(row.record))));
  }

  get(tenantId: string, deviceId: string): DeviceRecord | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT record FROM devices WHERE tenant = ? AND id = ?").get(tenantId, deviceId);
    return row ? deviceRecordSchema.parse(JSON.parse(String(row.record))) : undefined;
  }

  authenticate(deviceId: string, secret: string, allowRevoked = false): DeviceRecord | undefined {
    this.assertOpen();
    if (!uuid.safeParse(deviceId).success || !HEX_64.test(secret)) return;
    const row = this.db.prepare("SELECT record, credential_hash FROM devices WHERE id = ?").get(deviceId);
    if (!row || !safeEqual(String(row.credential_hash), hashSecret(secret), { format: HEX_64 })) return;
    const device = deviceRecordSchema.parse(JSON.parse(String(row.record)));
    return allowRevoked || device.revokedAt === undefined ? device : undefined;
  }

  async revoke(tenantId: string, deviceId: string): Promise<boolean> {
    this.assertOpen();
    return transaction(this.db, () => {
      const device = this.get(tenantId, deviceId);
      if (!device) return false;
      device.revokedAt ??= this.clock.now();
      this.db.prepare("UPDATE devices SET record = ? WHERE id = ?").run(JSON.stringify(device), deviceId);
      return true;
    });
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
  private assertOpen(): void {
    if (this.closed) throw new Error("device_registry_unavailable");
  }
}
