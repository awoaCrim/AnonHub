import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { denyToolPolicy } from "@yesimbot/contracts";
import { expect, it } from "vitest";

import { loadLocalRuntimeConfig, startLocalDeviceRuntime } from "../src/local-runtime.js";

it("loads a local Linux desktop and rejects remote or duplicate desktop drivers", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-linux-"));
  try {
    const tenantId = randomUUID();
    const config = {
      version: 1,
      tenantId,
      deviceId: randomUUID(),
      name: "ANON Linux",
      createdAt: 1,
      stateDirectory: "state",
      workspaceRoot: "workspace",
      policy: denyToolPolicy(),
      capabilities: { files: true, shell: true, desktop: { endpoint: "http://127.0.0.1:18200/sse" } },
    };
    const file = join(root, "local.json");
    const save = (value: unknown) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
    await save(config);
    const loaded = await loadLocalRuntimeConfig(file, tenantId);
    const runtime = await startLocalDeviceRuntime(loaded);
    try {
      expect((await runtime.list())[0].capabilities).toEqual(["workspace.files", "computer.shell", "computer.desktop"]);
    } finally {
      await runtime.close();
    }
    await save({ ...config, capabilities: { desktop: { endpoint: "http://192.168.1.1:18200/sse" } } });
    await expect(loadLocalRuntimeConfig(file, tenantId)).rejects.toThrow("local_desktop_endpoint_required");
    await save({ ...config, capabilities: { ...config.capabilities, windows: { workerScript: "worker.ps1" } } });
    await expect(loadLocalRuntimeConfig(file, tenantId)).rejects.toThrow("duplicate_local_desktop_driver");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
