import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const writer = new URL("../../docker/computer/write-config.mjs", import.meta.url);
test("managed computer enables loopback desktop for new and existing configs, preserving local choices", () => {
  const directory = mkdtempSync(join(tmpdir(), "computer-config-"));
  try {
    const run = () =>
      execFileSync(process.execPath, [writer.pathname, directory], { env: { ...process.env, YESIMBOT_DEVICE_GATEWAY: "https://devices.example" } });
    run();
    const file = join(directory, "config.json"),
      fresh = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(fresh.capabilities.remoteDesktop, { port: 5900 });
    assert.equal(statSync(file).mode & 0o077, 0);
    delete fresh.capabilities.remoteDesktop;
    fresh.policy.direct = { enabled: false, tools: [] };
    fresh.gateway = "https://preserved.example";
    writeFileSync(file, JSON.stringify(fresh));
    run();
    const migrated = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(migrated, { ...fresh, capabilities: { ...fresh.capabilities, remoteDesktop: { port: 5900 } } });
    migrated.capabilities.remoteDesktop = { port: 5901 };
    writeFileSync(file, JSON.stringify(migrated));
    run();
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), migrated);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
