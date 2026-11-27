import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { manualClock } from "@yesimbot/foundation";
import { afterEach, describe, expect, it } from "vitest";

import { DeviceRegistry } from "../src/registry.js";

const tenant = "11111111-1111-4111-8111-111111111111",
  foreign = "22222222-2222-4222-8222-222222222222";
const directories: string[] = [],
  registries: DeviceRegistry[] = [];
async function open() {
  const directory = await mkdtemp(join(tmpdir(), "device-registry-"));
  directories.push(directory);
  const registry = await DeviceRegistry.open(directory);
  registries.push(registry);
  return { registry, directory };
}
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("device enrollment", () => {
  it("binds one-use pairing to its tenant, stores only credential hashes, and survives reopen", async () => {
    const { registry, directory } = await open();
    const pairing = registry.createPairing(tenant);
    const input = { code: pairing.code, name: "Owner computer", platform: "win32" as const, capabilities: ["computer.shell" as const] };
    const enrolled = await registry.enroll(input);
    await expect(registry.enroll(input)).rejects.toThrow("invalid_pairing");
    expect(registry.list(foreign)).toEqual([]);
    expect(registry.get(foreign, enrolled.device.deviceId)).toBeUndefined();
    expect(registry.authenticate(enrolled.device.deviceId, "a".repeat(64))).toBeUndefined();
    expect(registry.authenticate(enrolled.device.deviceId, enrolled.credential.secret)).toEqual(enrolled.device);
    await registry.close();
    const bytes = await readFile(join(directory, "devices.sqlite"));
    expect(bytes.includes(enrolled.credential.secret)).toBe(false);
    expect(bytes.includes(pairing.code)).toBe(false);
    const reopened = await DeviceRegistry.open(directory);
    registries.push(reopened);
    expect(reopened.list(tenant)).toEqual([enrolled.device]);
    expect(await reopened.revoke(foreign, enrolled.device.deviceId)).toBe(false);
    expect(await reopened.revoke(tenant, enrolled.device.deviceId)).toBe(true);
    expect(reopened.authenticate(enrolled.device.deviceId, enrolled.credential.secret)).toBeUndefined();
  });

  it("atomically consumes pairing even with two registry handles", async () => {
    const { registry, directory } = await open();
    const second = await DeviceRegistry.open(directory);
    registries.push(second);
    const code = registry.createPairing(tenant).code;
    const results = await Promise.allSettled([registry, second].map((r) => r.enroll({ code, name: "Computer", platform: "linux", capabilities: [] })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(registry.list(tenant)).toHaveLength(1);
  });

  it("rejects expired pairing and symlink state directories", async () => {
    const { directory } = await open();
    const clock = manualClock(100);
    const registry = await DeviceRegistry.open(join(directory, "clock"), clock);
    registries.push(registry);
    const code = registry.createPairing(tenant).code;
    clock.advance(300_000);
    await expect(registry.enroll({ code, name: "Computer", platform: "darwin", capabilities: [] })).rejects.toThrow("invalid_pairing");
    await symlink(join(directory, "clock"), join(directory, "linked"));
    await expect(DeviceRegistry.open(join(directory, "linked"))).rejects.toThrow("unsafe_state_directory");
  });

  it("refuses to enroll a device with a WeChat capability", async () => {
    const { registry } = await open();
    await expect(
      registry.enroll({ code: registry.createPairing(tenant).code, name: "New", platform: "win32", capabilities: ["wechat.send" as never] }),
    ).rejects.toThrow();
  });
});
