import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeviceProcessLease } from "@yesimbot/device-store";
import { it, expect } from "vitest";

import { RuntimeCredentials } from "../src/runtime-auth.js";
const tenant = "11111111-1111-4111-8111-111111111111";
it("keeps runtime credential recovery idempotent but cannot undo revocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-credential-"));
  const credentials = await RuntimeCredentials.open(dir);
  try {
    const value = credentials.provision(tenant);
    credentials.ensure(tenant, value.token);
    expect(credentials.authenticate(`Bearer ${value.token}`)).toBe(tenant);
    expect(() => credentials.ensure(tenant, "f".repeat(64))).toThrow("mismatch");
    credentials.revoke(tenant);
    expect(credentials.authenticate(`Bearer ${value.token}`)).toBeUndefined();
    expect(() => credentials.ensure(tenant, value.token)).toThrow("revoked");
  } finally {
    credentials.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it("holds a single process lease and releases it on close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "device-lease-")),
    lease = await DeviceProcessLease.acquire(dir);
  try {
    await expect(DeviceProcessLease.acquire(dir)).rejects.toThrow("already_running");
  } finally {
    lease.close();
  }
  const again = await DeviceProcessLease.acquire(dir);
  again.close();
  await rm(dir, { recursive: true, force: true });
});
