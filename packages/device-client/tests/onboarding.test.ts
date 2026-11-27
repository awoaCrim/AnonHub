import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeviceCredential, DeviceInvocation } from "@yesimbot/contracts";
import { bindDeviceDirectory, DeviceProcessLease, OperationStore } from "@yesimbot/device-store";
import { afterEach, expect, it, vi } from "vitest";

import { DeviceGateway } from "../../device-gateway/src/gateway.js";
import { configuredCapabilities, readPrivateJson, validateClientConfig, writePrivateJson } from "../src/config.js";
import { ClientController, initialClientConfig } from "../src/controller.js";
import { startDashboard } from "../src/dashboard.js";
import { deviceStateDirectory } from "../src/runtime.js";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
it("announces agent-desktop and browser capabilities without allowing remote control endpoints or two desktop drivers", () => {
  const base = {
    ...initialClientConfig(),
    gateway: "https://devices.example.com",
    capabilities: {
      files: true,
      shell: true,
      shellConversationDirectory: true,
      agentDesktop: { command: "/home/anon/.local/bin/agent-desktop" },
      browser: { endpoint: "http://127.0.0.1:20422" },
    },
  };
  expect(configuredCapabilities(validateClientConfig(base))).toEqual(["workspace.files", "computer.shell", "computer.desktop", "computer.browser"]);
  expect(() => validateClientConfig({ ...base, capabilities: { ...base.capabilities, desktop: { endpoint: "http://127.0.0.1:18200/sse" } } })).toThrow(
    "duplicate_local_desktop_driver",
  );
  expect(() => validateClientConfig({ ...base, capabilities: { ...base.capabilities, browser: { endpoint: "http://192.168.1.2:9222" } } })).toThrow(
    "local_desktop_endpoint_required",
  );
});
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "device-onboarding-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const tenant = randomUUID();
  const gateway = await DeviceGateway.open({ directory: join(root, "gateway"), authenticate: async () => undefined, authorize: () => true });
  const server = createServer((request, response) => {
    void gateway.handleHttp(request, response);
  });
  gateway.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    await gateway.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const state = join(root, "client"),
    controller = await ClientController.open({ state });
  cleanup.push(() => controller.close());
  const config = validateClientConfig({
    ...initialClientConfig(),
    gateway: url,
    allowLoopback: true,
    capabilities: { files: true, shell: false },
    policy: {
      version: 1,
      direct: { enabled: true, tools: ["workspace.files.write", "workspace.files.read"] },
      group: { enabled: false, tools: [] },
      actors: [{ kind: "direct", platform: "wechat-bridge", conversationId: "crimson", userId: "crimson", botId: "anon" }],
    },
  });
  const save = async (value: unknown = config) => controller.save(value, (await controller.configuration()).revision);
  const pair = async () => {
    await controller.pair(gateway.registry.createPairing(tenant).code, "My computer");
    return (await readPrivateJson(join(state, "credential.json"))) as DeviceCredential;
  };
  return { root, state, tenant, gateway, controller, config, url, save, pair };
}

it("starts with no privileges, serializes revisions, and validates native configuration before saving", async () => {
  const { controller, config, save, state } = await fixture();
  expect(await controller.snapshot()).toEqual({ state: "stopped", paired: false });
  expect((await controller.configuration()).config).toMatchObject({
    capabilities: { files: false, shell: false },
    policy: { actors: [], direct: { enabled: false }, group: { enabled: false } },
  });
  const original = await controller.configuration();
  await save();
  await expect(controller.save({ ...config, capabilities: { files: false } }, original.revision)).rejects.toThrow("config_changed");
  const before = await readFile(join(state, "config.json"), "utf8");
  await expect(save({ ...config, capabilities: { desktop: { endpoint: "https://other.example/mcp" } } })).rejects.toThrow("local_desktop_endpoint_required");
  expect(await readFile(join(state, "config.json"), "utf8")).toBe(before);
  if (process.platform !== "win32") expect((await stat(join(state, "config.json"))).mode & 0o077).toBe(0);
  await save({ ...config, capabilities: { files: false, shell: false } });
  await expect(controller.pair("a".repeat(48), "computer")).rejects.toThrow("select_capabilities_first");
});

it("runs file-only capabilities, preserves exactly-once operations through pause/restart and re-pairing", async () => {
  const { controller, config, save, pair, gateway, tenant, state } = await fixture();
  await save();
  const credential = await pair();
  expect(JSON.stringify(await controller.snapshot())).not.toContain(credential.secret);
  await expect(save({ ...config, capabilities: { files: true, shell: true } })).rejects.toThrow("unpair_before_expanding_capabilities");
  await expect(save({ ...config, capabilities: { ...config.capabilities, browser: { endpoint: "http://127.0.0.1:9222/" } } })).rejects.toThrow(
    "unpair_before_expanding_capabilities",
  );
  await controller.start();
  await vi.waitFor(async () => expect((await controller.snapshot()).state).toBe("online"));
  await expect(save()).rejects.toThrow("stop_before_editing");
  const request: DeviceInvocation = {
    operationId: randomUUID(),
    capability: "workspace.files",
    method: "write",
    expiresAt: Date.now() + 30_000,
    conversation: { tenantId: tenant, botId: "anon", platform: "wechat-bridge", kind: "direct", conversationId: "crimson" },
    actors: [{ platform: "wechat-bridge", userId: "crimson" }],
    input: { path: "proof.txt", data: Buffer.from("first write").toString("base64") },
  };
  expect(await gateway.invoke(tenant, credential.deviceId, request)).toMatchObject({ status: "succeeded" });
  const [namespace] = await readdir(join(state, "workspaces"));
  const file = join(state, "workspaces", namespace!, "proof.txt");
  // A repeat must return the stored result rather than restore old content.
  await writeFile(file, "user edit");
  await controller.stop();
  await vi.waitFor(() => expect(gateway.list(tenant)[0]?.online).toBe(false));
  await controller.start();
  await vi.waitFor(async () => expect((await controller.snapshot()).state).toBe("online"));
  expect(await gateway.invoke(tenant, credential.deviceId, request)).toMatchObject({ status: "succeeded" });
  expect(await readFile(file, "utf8")).toBe("user edit");
  expect(
    await gateway.invoke(tenant, credential.deviceId, { ...request, operationId: randomUUID(), conversation: { ...request.conversation, kind: "group" } }),
  ).toMatchObject({ status: "rejected", code: "policy_denied" });
  const oldDirectory = deviceStateDirectory(state, credential);
  await controller.unpair();
  expect(gateway.registry.authenticate(credential.deviceId, credential.secret)).toBeUndefined();
  expect(await readPrivateJson(join(state, "retired", credential.deviceId, "credential.json"))).toEqual(credential);
  expect((await stat(join(oldDirectory, "operations.sqlite"))).isFile()).toBe(true);
  await save({ ...config, capabilities: { files: true, shell: true } });
  const next = await pair();
  expect(next.deviceId).not.toBe(credential.deviceId);
  expect(deviceStateDirectory(state, next)).not.toBe(oldDirectory);
  expect(await gateway.invoke(tenant, next.deviceId, request)).toMatchObject({ status: "rejected", code: "operation_id_conflict" });
  expect(await readFile(file, "utf8")).toBe("user edit");
});

it("preserves credentials when self revocation cannot be confirmed and retries idempotently", async () => {
  const { controller, save, pair, gateway, state } = await fixture();
  await save();
  const credential = await pair();
  const revoke = vi.spyOn(gateway, "revoke").mockRejectedValueOnce(new Error("temporary_failure"));
  await expect(controller.unpair()).rejects.toThrow("revocation_not_confirmed");
  expect(await readPrivateJson(join(state, "credential.json"))).toEqual(credential);
  revoke.mockRestore();
  await gateway.revoke(credential.tenantId, credential.deviceId); // prior response was lost
  await controller.unpair();
  expect((await controller.snapshot()).paired).toBe(false);
});

it("diagnoses connectivity without invoking native actions or desktop operations", async () => {
  const { controller, save, config } = await fixture();
  const requests: string[] = [];
  const native = createServer((req, res) => {
    requests.push(req.url!);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ enabled: false }));
  });
  await new Promise<void>((resolve) => native.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        native.closeAllConnections();
        native.close(() => resolve());
      }),
  );
  const port = (native.address() as { port: number }).port;
  await save({
    ...config,
    capabilities: {
      desktop: { endpoint: `http://127.0.0.1:${port}/sse` },
    },
  });
  expect((await controller.diagnose()).map((item) => [item.id, item.ok])).toEqual([
    ["gateway", true],
    ["desktop", true],
  ]);
  expect(requests).toEqual([]);
  expect((await controller.snapshot()).state).toBe("stopped");
});

it("checks the configured browser protocol without reading or operating pages", async () => {
  const { controller, save, config } = await fixture();
  const requests: string[] = [];
  let ready = true;
  const browser = createServer((req, res) => {
    requests.push(req.url!);
    res.setHeader("content-type", "application/json");
    res.end(ready ? "[]" : "{}");
  });
  await new Promise<void>((resolve) => browser.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => browser.close(() => resolve())));
  const port = (browser.address() as { port: number }).port;
  await save({ ...config, capabilities: { browser: { endpoint: `http://127.0.0.1:${port}/` } } });
  expect(await controller.diagnose()).toContainEqual(expect.objectContaining({ id: "browser", ok: true }));
  ready = false;
  expect(await controller.diagnose()).toContainEqual(expect.objectContaining({ id: "browser", ok: false }));
  expect(requests).toEqual(["/json/list", "/json/list"]);
  expect((await controller.snapshot()).state).toBe("stopped");
});

it("protects loopback UI APIs from foreign origins, DNS rebinding and credential disclosure", async () => {
  const { controller, state, save, pair } = await fixture();
  await save();
  const credential = await pair();
  const dashboard = await startDashboard(controller);
  cleanup.push(() => dashboard.close());
  const headers = { authorization: `Bearer ${dashboard.token}` };
  expect((await fetch(dashboard.origin + "/api/snapshot")).status).toBe(401);
  for (const extra of [{ origin: "https://evil.example" }, { host: "evil.example" }, { "sec-fetch-site": "cross-site" }]) {
    // Native HTTP preserves hostile Host/fetch-metadata headers that fetch may replace.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      get(dashboard.origin + "/api/snapshot", { headers: { ...headers, ...extra } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).once("error", reject);
    });
    expect(status).toBe(403);
  }
  const snapshot = await fetch(dashboard.origin + "/api/snapshot", { headers });
  expect(await snapshot.json()).toMatchObject({ paired: true, deviceId: credential.deviceId });
  const config = await fetch(dashboard.origin + "/api/config", { headers });
  expect(await config.text()).not.toContain(credential.secret);
  const page = await fetch(dashboard.origin);
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(await page.text()).not.toContain(dashboard.token);
  expect((await fetch(dashboard.origin + "/api/stop", { method: "POST", headers, body: "{}" })).status).toBe(405);
  expect(
    (await fetch(dashboard.origin + "/api/stop", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "[]" })).status,
  ).toBe(400);
  expect(await readPrivateJson(join(state, "control", "ui.json"))).toEqual({ version: 1, origin: dashboard.origin, token: dashboard.token });
  if (process.platform !== "win32") expect((await stat(join(state, "control", "ui.json"))).mode & 0o077).toBe(0);
  await dashboard.close();
  await expect(readFile(join(state, "control", "ui.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not overwrite a linked configuration file", async () => {
  const { state } = await fixture();
  const { symlink } = await import("node:fs/promises");
  const target = join(state, "target.json"),
    link = join(state, "link.json");
  await writePrivateJson(target, { saved: true });
  await symlink(target, link);
  await expect(writePrivateJson(link, { saved: false })).rejects.toThrow("unsafe_config_file");
  expect(await readPrivateJson(target)).toEqual({ saved: true });
});

it("waits for the same complete shutdown when close is called concurrently", async () => {
  const { controller, save, pair, state } = await fixture();
  const { EventEmitter } = await import("node:events");
  let finish!: () => void;
  const cleanupRuntime = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  controller.options.startRuntime = async () => ({ client: new EventEmitter() as import("../src/client.js").DeviceClient, close: cleanupRuntime });
  await save();
  await pair();
  await controller.start();
  const first = controller.close();
  let secondFinished = false;
  const second = controller.close().then(() => {
    secondFinished = true;
  });
  await vi.waitFor(() => expect(cleanupRuntime).toHaveBeenCalledTimes(1));
  expect(secondFinished).toBe(false);
  await expect(ClientController.open({ state })).rejects.toThrow("device_client_already_running");
  finish();
  await Promise.all([first, second]);
  const reopened = await ClientController.open({ state });
  await reopened.close();
});
