#!/usr/bin/env node
import { open, mkdir, readFile, lstat, link, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { uuid } from "@yesimbot/contracts";
import { newId, newSecret } from "@yesimbot/foundation";

import { DeviceGateway } from "./gateway.js";
import { localAddressAllowed, parseLocalNetworks } from "./local-listener.js";
import { RuntimeCredentials } from "./runtime-auth.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      state: { type: "string" },
      tenant: { type: "string" },
      output: { type: "string" },
      port: { type: "string" },
      // Optional second listener for containers/VMs on this host: cleartext, all interfaces, only host-bridge addresses.
      "local-port": { type: "string" },
      "local-allow": { type: "string" },
    },
  });
  if (!values.state || positionals.length !== 1 || !["serve", "provision-runtime", "ensure-runtime", "revoke-runtime"].includes(positionals[0]!))
    throw new Error("invalid_gateway_command");
  const directory = resolve(values.state),
    credentials = await RuntimeCredentials.open(directory);
  if (positionals[0] === "provision-runtime" || positionals[0] === "ensure-runtime") {
    try {
      if (!values.tenant || !values.output) throw new Error("runtime_identity_and_output_required");
      const path = resolve(values.output);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      uuid.parse(values.tenant);
      const temporary = path + "." + newId() + ".tmp";
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify({ version: 1, tenantId: values.tenant, token: newSecret(32, { encoding: "hex" }) }) + "\n");
          await file.sync();
        } finally {
          await file.close();
        }
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || positionals[0] !== "ensure-runtime") throw error;
      } finally {
        await unlink(temporary).catch(() => {});
      }
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
        throw new Error("invalid_runtime_credential_file");
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value.version !== 1 || value.tenantId !== values.tenant) throw new Error("runtime_identity_mismatch");
      credentials.ensure(value.tenantId, value.token);
      process.stdout.write("运行实例凭证已写入指定私有文件。\n");
    } finally {
      credentials.close();
    }
    return;
  }
  if (positionals[0] === "revoke-runtime") {
    try {
      if (!values.tenant) throw new Error("tenant_required");
      credentials.revoke(values.tenant);
    } finally {
      credentials.close();
    }
    return;
  }
  const port = Number(values.port ?? "17400");
  const localPort = values["local-port"] === undefined ? undefined : Number(values["local-port"]);
  let localNetworks: ReturnType<typeof parseLocalNetworks> = [];
  try {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid_port");
    if ((localPort === undefined) !== (values["local-allow"] === undefined)) throw new Error("local_port_and_allow_required");
    if (localPort !== undefined && (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535 || localPort === port))
      throw new Error("invalid_port");
    if (values["local-allow"] !== undefined) localNetworks = parseLocalNetworks(values["local-allow"]);
  } catch (error) {
    credentials.close();
    throw error;
  }
  const gateway = await DeviceGateway.open({
    directory,
    authenticate: async (request) => credentials.authenticate(request.headers.authorization),
    authorize: (invocation, device) =>
      invocation.conversation.tenantId === device.tenantId && invocation.actors.every((actor) => actor.platform === invocation.conversation.platform),
  });
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    void gateway.handleHttp(request, response);
  };
  const server = createServer(handle);
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  gateway.attach(server);
  server.listen(port, "127.0.0.1", () => process.stdout.write(`设备网关已监听 127.0.0.1:${port}；公网接入需要 HTTPS 反向代理。\n`));
  const local = localPort === undefined ? undefined : createServer(handle);
  if (local) {
    local.requestTimeout = 30_000;
    local.headersTimeout = 15_000;
    // Bound to every interface so new bridges work without a restart; anything else (the LAN) is cut off unread.
    local.on("connection", (socket) => {
      if (!localAddressAllowed(socket.localAddress, localNetworks)) socket.destroy();
    });
    gateway.attach(local);
    local.listen(localPort, "0.0.0.0", () => process.stdout.write(`本机容器入口已监听 :${localPort}（仅 ${values["local-allow"]}）。\n`));
  }
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    server.close();
    local?.close();
    await gateway.close();
    credentials.close();
  };
  process.once("SIGTERM", () => {
    void close();
  });
  process.once("SIGINT", () => {
    void close();
  });
}
main().catch(() => {
  process.stderr.write("device_gateway_failed\n");
  process.exitCode = 1;
});
