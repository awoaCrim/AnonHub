import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);

function initialize() {
  const state = process.env.KOISHI_STATE_DIR || "/var/lib/yesimbot";
  const napcat = process.env.NAPCAT_CONFIG_DIR || "/app/napcat/config";
  const account = process.env.QQ_ACCOUNT || "";
  const secretFile = process.env.ADMIN_PASSWORD_FILE || "/run/secrets/admin-password";
  const publicOrigin = process.env.ADMIN_PUBLIC_ORIGIN || "";
  const tenantId = process.env.YESIMBOT_TENANT_ID || "";
  const gateway = process.env.YESIMBOT_DEVICE_GATEWAY || "";
  const gatewayCredential = process.env.YESIMBOT_DEVICE_CREDENTIAL_FILE || "";
  // The same gateway on this container's own bridge (set by the account manager); the public one stays the fallback.
  const localGateway = process.env.YESIMBOT_DEVICE_LOCAL_GATEWAY || "";
  if (localGateway) {
    const url = new URL(localGateway);
    const octets = url.hostname.split(".").map(Number);
    const privateIPv4 =
      octets.length === 4 &&
      octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
      (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168));
    if (!gateway || url.protocol !== "http:" || !url.port || url.origin !== localGateway || !privateIPv4)
      throw new Error("Invalid local device gateway configuration.");
  }
  if (gateway) {
    const url = new URL(gateway);
    if (url.protocol !== "https:" || url.origin !== gateway || url.username || url.password || !path.isAbsolute(gatewayCredential))
      throw new Error("Invalid device gateway configuration.");
    const credential = JSON.parse(fs.readFileSync(gatewayCredential, "utf8"));
    if (credential.version !== 1 || credential.tenantId !== tenantId || !/^[a-f0-9]{64}$/.test(credential.token))
      throw new Error("Device gateway identity mismatch.");
  }
  if (tenantId && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(tenantId)) {
    throw new Error("YESIMBOT_TENANT_ID must be a UUIDv4.");
  }
  let additionalOrigins = [];
  if (process.env.ADMIN_ADDITIONAL_ORIGINS_JSON) {
    try {
      additionalOrigins = JSON.parse(process.env.ADMIN_ADDITIONAL_ORIGINS_JSON);
      if (!Array.isArray(additionalOrigins) || !publicOrigin || additionalOrigins.length > 16) throw new Error();
      for (const value of additionalOrigins) {
        const parsed = new URL(value);
        if (
          typeof value !== "string" ||
          !["http:", "https:"].includes(parsed.protocol) ||
          parsed.origin !== value ||
          parsed.hostname.includes("*") ||
          parsed.username ||
          parsed.password
        )
          throw new Error();
      }
    } catch {
      throw new Error("ADMIN_ADDITIONAL_ORIGINS_JSON must contain exact HTTP(S) origins and requires ADMIN_PUBLIC_ORIGIN.");
    }
  }
  if (tenantId && !publicOrigin) throw new Error("Tenant initialization requires ADMIN_PUBLIC_ORIGIN.");
  if (publicOrigin) {
    const origin = new URL(publicOrigin);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.origin !== publicOrigin ||
      origin.hostname.includes("*") ||
      origin.username ||
      origin.password
    ) {
      throw new Error("ADMIN_PUBLIC_ORIGIN must be an exact HTTP(S) origin without credentials, path or query.");
    }
  }
  const replaceAtomic = (file, contents) => {
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, contents);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
      const parent = fs.openSync(path.dirname(file), "r");
      try {
        fs.fsyncSync(parent);
      } finally {
        fs.closeSync(parent);
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  };
  const writeNew = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  };
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.mkdirSync(napcat, { recursive: true, mode: 0o700 });
  // agent-wechat refuses a data directory or token file others can read, and an explicit token file that is missing.
  const wechatData = path.join(state, "data/agent-wechat");
  fs.mkdirSync(wechatData, { recursive: true, mode: 0o700 });
  fs.chmodSync(wechatData, 0o700);
  try {
    fs.writeFileSync(path.join(wechatData, "api-token"), randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const credentials = path.join(state, "data/console-admin/credential.json");
  if (!fs.existsSync(credentials)) {
    const password = fs.readFileSync(secretFile, "utf8").replace(/\r?\n$/, "");
    if (password.length < 12 || password.length > 4096) throw new Error("Administrator password must contain between 12 and 4096 characters.");
    const salt = randomBytes(16);
    writeNew(credentials, { version: 1, username: "admin", salt: salt.toString("base64"), hash: scryptSync(password, salt, 64).toString("base64") });
  }
  const configDir = path.join(state, "config");
  const endpointFile = path.join(state, "data/onebot/endpoint.json");
  const freshConfig = !fs.existsSync(configDir);
  // Koishi's koishi.yml was split into config/ when each runtime left Koishi (leave-koishi stage 7); nothing reads it now.
  if (freshConfig && fs.existsSync(path.join(state, "koishi.yml")))
    throw new Error("This runtime's settings are still in koishi.yml, which this version no longer reads; they belong in config/.");
  if (account && !/^[1-9][0-9]{4,14}$/.test(account)) throw new Error("QQ_ACCOUNT must be a valid QQ account number when supplied.");
  if (freshConfig) writeNew(endpointFile, { path: `/onebot/${randomBytes(32).toString("hex")}` });
  // Older managed installations retain their original endpoint until explicitly migrated.
  let onebotPath = "/onebot";
  if (fs.existsSync(endpointFile)) {
    try {
      onebotPath = JSON.parse(fs.readFileSync(endpointFile, "utf8")).path;
      if (typeof onebotPath !== "string" || !/^\/onebot\/[a-f0-9]{64}$/.test(onebotPath)) throw new Error();
    } catch {
      throw new Error("Invalid internal OneBot endpoint state.");
    }
  }
  const consoleNapcat = { enabled: !!account, endpoint: "http://127.0.0.1:6099", webuiConfigFile: "/app/napcat/config/webui.json" };
  const consoleAdmin = {
    enabled: true,
    credentialFile: "data/console-admin/credential.json",
    sessionHours: 168,
    ...(publicOrigin ? { publicOrigin } : {}),
    ...(additionalOrigins.length ? { additionalOrigins } : {}),
  };
  const deviceConnection = () => ({ gateway, ...(localGateway ? { localGateway } : {}), credentialFile: gatewayCredential });
  if (freshConfig) {
    // One file per module; the OneBot path is a bearer secret, kept in secrets/.
    const staging = `${configDir}.${randomUUID()}.tmp`;
    fs.mkdirSync(path.join(staging, "secrets"), { recursive: true, mode: 0o700 });
    const files = {
      "app.json": { server: { host: "0.0.0.0", port: 5140 } },
      "yesimbot.json": { enabled: true, config: { allowedChannels: [] } },
      "yesimbot-console.json": { enabled: true, config: { webui: { enabled: true }, admin: consoleAdmin, napcat: consoleNapcat, wechat: { enabled: true } } },
      // An empty collection creates no model clients or outbound requests until a connection is added.
      "yesimbot-model-provider.json": { enabled: true, config: { connections: [] } },
      ...(account
        ? {
            "adapter-onebot.json": { enabled: true, config: { selfId: account, protocol: "ws-reverse", path: { $secret: "/path" } } },
            "secrets/adapter-onebot.json": { "/path": onebotPath },
          }
        : {}),
      ...(gateway ? { "yesimbot-device-connection.json": { enabled: true, config: deviceConnection() } } : {}),
    };
    try {
      for (const [name, value] of Object.entries(files))
        fs.writeFileSync(path.join(staging, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      fs.renameSync(staging, configDir);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  // Only runtimes created with this connector manifest are managed here. Legacy configs need explicit adoption.
  const connectorsFile = path.join(state, "data/managed-connectors.json");
  if (freshConfig) writeNew(connectorsFile, { version: 1, qqAccount: account, gateway, ...(localGateway ? { localGateway } : {}) });
  if (!freshConfig && fs.existsSync(connectorsFile)) {
    const managed = JSON.parse(fs.readFileSync(connectorsFile, "utf8"));
    if (managed.version !== 1 || (managed.qqAccount && account && managed.qqAccount !== account)) throw new Error("Managed chat account mismatch.");
    const adopt = (account && !managed.qqAccount) || gateway !== managed.gateway || localGateway !== (managed.localGateway ?? "");
    if (adopt) {
      const moduleFile = (id) => path.join(configDir, `${id}.json`);
      const readModule = (id) => (fs.existsSync(moduleFile(id)) ? JSON.parse(fs.readFileSync(moduleFile(id), "utf8")) : undefined);
      const writeModule = (file, value) => replaceAtomic(file, JSON.stringify(value, null, 2) + "\n");
      if (account && !managed.qqAccount) {
        const existing = readModule("adapter-onebot");
        if (existing && existing.config?.selfId !== account) throw new Error("Managed QQ connector conflicts with existing configuration.");
        if (!existing) {
          fs.mkdirSync(path.join(configDir, "secrets"), { recursive: true, mode: 0o700 });
          writeModule(path.join(configDir, "secrets/adapter-onebot.json"), { "/path": onebotPath });
          writeModule(moduleFile("adapter-onebot"), { enabled: true, config: { selfId: account, protocol: "ws-reverse", path: { $secret: "/path" } } });
        }
        const consoleModule = readModule("yesimbot-console");
        if (consoleModule?.config) {
          consoleModule.config.napcat = { ...consoleModule.config.napcat, ...consoleNapcat, enabled: true };
          writeModule(moduleFile("yesimbot-console"), consoleModule);
        }
      }
      if (gateway) writeModule(moduleFile("yesimbot-device-connection"), { enabled: true, config: deviceConnection() });
      else fs.rmSync(moduleFile("yesimbot-device-connection"), { force: true });
    }
    // Recorded last, so an adoption cut short runs again on the next start.
    if (adopt)
      replaceAtomic(
        connectorsFile,
        JSON.stringify({ version: 1, qqAccount: account || managed.qqAccount, gateway, ...(localGateway ? { localGateway } : {}) }) + "\n",
      );
  }
  writeNew(path.join(napcat, "webui.json"), { host: "127.0.0.1", port: 6099, prefix: "", token: randomBytes(32).toString("hex"), loginRate: 3 });
  const onebot = {
    network: {
      httpServers: [],
      httpSseServers: [],
      httpClients: [],
      websocketServers: [],
      websocketClients: [
        {
          name: "yesimbot",
          enable: true,
          url: `ws://127.0.0.1:5140${onebotPath}`,
          messagePostFormat: "array",
          reportSelfMessage: false,
          reconnectInterval: 5000,
          heartInterval: 30000,
          token: "",
          debug: false,
        },
      ],
    },
    musicSignUrl: "",
    enableLocalFile2Url: true,
    parseMultMsg: false,
  };
  writeNew(path.join(napcat, "onebot11.json"), onebot);
  if (/^[1-9][0-9]{4,14}$/.test(account)) writeNew(path.join(napcat, `onebot11_${account}.json`), onebot);
}

initialize();
