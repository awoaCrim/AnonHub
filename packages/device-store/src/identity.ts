import { ensureSchema, openDeviceDatabase, transaction } from "./database.js";

/** Prevents accidental reuse of another account/device's ledger or private native state. */
export async function bindDeviceDirectory(directory: string, identity: { tenantId: string; deviceId: string }): Promise<void> {
  const db = await openDeviceDatabase(directory, "identity");
  try {
    ensureSchema(db, "CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id = 1), tenant TEXT NOT NULL, device TEXT NOT NULL);");
    transaction(db, () => {
      const existing = db.prepare("SELECT tenant, device FROM identity WHERE id = 1").get();
      if (existing) {
        if (existing.tenant !== identity.tenantId || existing.device !== identity.deviceId) throw new Error("device_directory_binding_mismatch");
        return;
      }
      db.prepare("INSERT INTO identity VALUES (1, ?, ?)").run(identity.tenantId, identity.deviceId);
    });
  } finally {
    db.close();
  }
}
