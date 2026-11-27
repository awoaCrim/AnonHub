import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  local: { close: vi.fn(async () => undefined) },
  loadLocalRuntimeConfig: vi.fn(async () => ({ deviceId: "local-device" })),
  startLocalDeviceRuntime: vi.fn(),
  gateways: [] as unknown[],
}));

vi.mock("@yesimbot/device-client", () => ({
  loadLocalRuntimeConfig: mocks.loadLocalRuntimeConfig,
  startLocalDeviceRuntime: mocks.startLocalDeviceRuntime,
  RoutedDeviceTransport: class {
    public constructor(
      public readonly deviceId: string,
      public readonly local: unknown,
      public readonly remote: unknown,
    ) {}
  },
}));
vi.mock("@yesimbot/device-gateway", () => ({
  GatewayClient: class {
    public constructor(public readonly options: unknown) {
      mocks.gateways.push(options);
    }
  },
}));

import { openDeviceConnection } from "../src/connection.js";
import { extension } from "../src/extension.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const defaults = { allowLoopback: false };
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "device-connection-"));
  mocks.gateways.length = 0;
  mocks.startLocalDeviceRuntime.mockResolvedValue(mocks.local);
  mocks.local.close.mockClear();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function credential(value: unknown, mode = 0o600): Promise<string> {
  const path = join(dir, "credential.json");
  await writeFile(path, JSON.stringify(value));
  await chmod(path, mode);
  return "credential.json";
}

describe("openDeviceConnection", () => {
  it("refuses a runtime with no device connection configured", async () => {
    await expect(openDeviceConnection(defaults, dir, tenantId)).rejects.toMatchObject({ code: "device_connection_config_required" });
  });

  it("needs the gateway and its credential file together", async () => {
    await expect(openDeviceConnection({ ...defaults, gateway: "https://gateway.example" }, dir, tenantId)).rejects.toMatchObject({
      code: "device_connection_config_incomplete",
    });
    await expect(openDeviceConnection({ ...defaults, credentialFile: "credential.json" }, dir, tenantId)).rejects.toMatchObject({
      code: "device_connection_config_incomplete",
    });
  });

  it("connects the remote gateway with this tenant's token", async () => {
    const credentialFile = await credential({ version: 1, tenantId, token: "secret-token" });
    const connection = await openDeviceConnection(
      { ...defaults, gateway: "https://gateway.example", credentialFile, localGateway: "http://10.0.0.2" },
      dir,
      tenantId,
    );
    expect(mocks.gateways).toEqual([
      { gateway: "https://gateway.example", token: "secret-token", tenantId, allowLoopback: false, localGateway: "http://10.0.0.2" },
    ]);
    await expect(connection.close()).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("refuses a credential file others can read", async () => {
    const credentialFile = await credential({ version: 1, tenantId, token: "secret-token" }, 0o644);
    await expect(openDeviceConnection({ ...defaults, gateway: "https://gateway.example", credentialFile }, dir, tenantId)).rejects.toMatchObject({
      code: "device_connection_credential_invalid",
    });
  });

  it("refuses a credential file reached through a symbolic link", async () => {
    await credential({ version: 1, tenantId, token: "secret-token" });
    await symlink(join(dir, "credential.json"), join(dir, "linked.json"));
    await expect(openDeviceConnection({ ...defaults, gateway: "https://gateway.example", credentialFile: "linked.json" }, dir, tenantId)).rejects.toMatchObject(
      { code: "device_connection_credential_invalid" },
    );
  });

  it("refuses a damaged credential and one that belongs to another runtime", async () => {
    const path = join(dir, "credential.json");
    await writeFile(path, "{not json");
    await chmod(path, 0o600);
    const config = { ...defaults, gateway: "https://gateway.example", credentialFile: "credential.json" };
    await expect(openDeviceConnection(config, dir, tenantId)).rejects.toMatchObject({ code: "device_connection_credential_invalid" });
    await credential({ version: 1, tenantId: "22222222-2222-4222-8222-222222222222", token: "secret-token" });
    await expect(openDeviceConnection(config, dir, tenantId)).rejects.toMatchObject({ code: "device_connection_identity_mismatch" });
  });

  it("routes other devices through the gateway when a local runtime is configured, and closes the local runtime", async () => {
    const credentialFile = await credential({ version: 1, tenantId, token: "secret-token" });
    const connection = await openDeviceConnection(
      { ...defaults, gateway: "https://gateway.example", credentialFile, localConfigFile: "local.json" },
      dir,
      tenantId,
    );
    expect(mocks.loadLocalRuntimeConfig).toHaveBeenCalledWith(join(dir, "local.json"), tenantId);
    expect(connection.transport).toMatchObject({ deviceId: "local-device", local: mocks.local, remote: { options: expect.objectContaining({ tenantId }) } });
    await connection.close();
    expect(mocks.local.close).toHaveBeenCalledOnce();
  });
});

describe("device connection extension", () => {
  const context = (use: (transport: unknown) => () => void) =>
    ({
      config: { ...defaults, localConfigFile: "local.json" },
      baseDir: dir,
      core: { identity: { tenantId: async () => tenantId }, devices: { use } },
    }) as never;

  it("attaches the transport, and its undo detaches before closing", async () => {
    const order: string[] = [];
    mocks.local.close.mockImplementationOnce(async () => void order.push("close"));
    const use = vi.fn(() => () => void order.push("detach"));
    const undo = await extension.start(context(use));
    expect(use).toHaveBeenCalledOnce();
    await (undo as () => Promise<void>)();
    expect(order).toEqual(["detach", "close"]);
  });

  it("closes the connection when Core refuses the transport", async () => {
    const use = vi.fn(() => {
      throw new Error("refused");
    });
    await expect(extension.start(context(use))).rejects.toThrow("refused");
    expect(mocks.local.close).toHaveBeenCalledOnce();
  });
});
