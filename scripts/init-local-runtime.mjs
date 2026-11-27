import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

// Creates an isolated, disconnected instance; production migration uses a separate reviewed manifest.
const [runtimeArg, stateArg] = process.argv.slice(2);
const runtime = resolve(runtimeArg),
  root = resolve(stateArg),
  app = join(root, "app"),
  id = randomUUID(),
  deviceId = randomUUID();
await mkdir(join(app, "data", "yesimbot"), { recursive: true, mode: 0o700 });
await mkdir(join(app, "data", "console-admin"), { recursive: true, mode: 0o700 });
await mkdir(join(root, "policy"), { recursive: true, mode: 0o700 });
const put = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const shape = JSON.parse(await readFile(join(runtime, "context-policy.json"), "utf8"));
const defaults = (shape) =>
  Object.fromEntries(
    Object.entries(shape).flatMap(([key, rule]) => (Array.isArray(rule) ? (rule[1] === null ? [] : [[key, rule[1]]]) : [[key, defaults(rule)]])),
  );
await put(join(root, "policy", "context.json"), { version: 1, session: defaults(shape) });
await put(join(app, "data", "yesimbot", "runtime-identity.json"), { version: 1, tenantId: id });
const password = randomBytes(32).toString("hex"),
  salt = randomBytes(16);
await put(join(app, "data", "console-admin", "credential.json"), {
  version: 1,
  username: "admin",
  salt: salt.toString("base64"),
  hash: scryptSync(password, salt, 64).toString("base64"),
});
await writeFile(join(root, "backend-password"), password, { flag: "wx", mode: 0o600 });
const policy = { version: 1, direct: { enabled: false, tools: [] }, group: { enabled: false, tools: [] }, actors: [] };
await put(join(app, "local-device.json"), {
  version: 1,
  tenantId: id,
  deviceId,
  name: "ANON 本机验收",
  createdAt: Date.now(),
  stateDirectory: join(root, "device"),
  workspaceRoot: join(root, "workspace"),
  policy,
  capabilities: { files: true, shell: true, windows: { workerScript: join(runtime, "desktop-worker.ps1") }, browser: { endpoint: "http://127.0.0.1:19322" } },
});
// The host's settings, one file per module (apps/server reads `<app>/config/`).
await mkdir(join(app, "config"), { recursive: true, mode: 0o700 });
const modules = {
  app: { server: { host: "127.0.0.1", port: 19440 } },
  yesimbot: { enabled: true, config: { basePath: "data/yesimbot", allowedChannels: [] } },
  "yesimbot-console": {
    enabled: true,
    config: {
      admin: { enabled: true, publicOrigin: "http://127.0.0.1:19440" },
      webui: { enabled: true },
      accounts: { enabled: false },
      napcat: { enabled: false },
    },
  },
  "yesimbot-device-connection": { enabled: true, config: { localConfigFile: "local-device.json" } },
  "yesimbot-workspace": {
    enabled: true,
    config: { storage: { kind: "device", deviceId }, computer: { deviceId } },
  },
};
for (const [name, value] of Object.entries(modules)) await put(join(app, "config", `${name}.json`), value);
const release = JSON.parse(await readFile(join(runtime, "release.json"), "utf8"));
await put(join(root, "host.json"), {
  version: 1,
  id,
  name: "ANON 本机验收",
  release: release.release,
  token: randomBytes(32).toString("hex"),
  node: join(runtime, "node.exe"),
  entry: join(runtime, "entry.cjs"),
  appRoot: app,
  stateRoot: root,
  port: 19441,
  backendPort: 19440,
});
console.log(JSON.stringify({ id, deviceId, initialized: true }));
