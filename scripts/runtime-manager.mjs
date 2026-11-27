#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
// Root-only host service. Docker and firewall arguments are derived exclusively
// from root configuration and UUID state, never from relay requests.
import http from "node:http";
import net from "node:net";

import {
  containerProgram,
  napcatWrapper,
  PART_LABEL,
  podCreateArgs,
  podEnvDrift,
  podNames,
  podParts,
  podSpec,
  staleJoin,
  validPodContainer,
} from "./runtime-pod.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const QQ = /^[1-9][0-9]{4,14}$/;
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const IMAGE_REFERENCE = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/;
const SUPERVISOR = ["-c", "/opt/yesimbot/docker/supervisord.conf"];
const RELEASE_FILE = "/opt/yesimbot/.yesimbot-release.json";
/** After a manager-driven restart, Docker's health may lag behind; monitor must not escalate meanwhile. */
const RESTART_GRACE_MS = 120000;
const LABEL = "io.yesimbot.runtime";
const installedCatalog = new URL("./plugin-catalog.json", import.meta.url);
const catalog = JSON.parse(
  fs.readFileSync(fs.existsSync(installedCatalog) ? installedCatalog : new URL("../packages/contracts/src/plugin-catalog.json", import.meta.url), "utf8"),
);
const OPTIONAL_PLUGINS = Object.freeze(catalog.optional.map((item) => item.name));
const POLICY_TARGET = "/run/yesimbot/policy";
const MOUNTS = [
  ["koishi", "/var/lib/yesimbot"],
  ["qq", "/app/.config/QQ"],
  ["napcat-config", "/app/napcat/config"],
  ["napcat-plugins", "/app/napcat/plugins"],
  ["backend-password", "/run/secrets/admin-password"],
  ["policy", POLICY_TARGET],
];
const READONLY = new Set(["/run/secrets/admin-password", POLICY_TARGET]);
const installedContext = new URL("./context-policy.json", import.meta.url);
const contextDefinition = JSON.parse(
  fs.readFileSync(fs.existsSync(installedContext) ? installedContext : new URL("../plugins/console/src/shared/context-policy.json", import.meta.url), "utf8"),
);

/**
 * The owner's Google app, as its console publishes it. Every friend borrows it, so friends never set up Google
 * themselves. Anything malformed is refused; "not set up" is `{ version: 1 }`.
 */
const GOOGLE_CALLBACK = "/yesimbot/api/v1/connectors/google/callback";
function validateGoogleApp(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== 1) throw fail("invalid-google-app");
  if (Object.keys(raw).some((key) => !["version", "clientId", "clientSecret", "redirectUri"].includes(key))) throw fail("invalid-google-app");
  const { clientId, clientSecret, redirectUri } = raw;
  if (clientId === undefined && clientSecret === undefined && redirectUri === undefined) return { version: 1 };
  if (typeof clientId !== "string" || !/^[\w.-]{1,200}\.apps\.googleusercontent\.com$/.test(clientId)) throw fail("invalid-google-app");
  if (typeof clientSecret !== "string" || !/^[\x21-\x7e]{1,200}$/.test(clientSecret)) throw fail("invalid-google-app");
  let url;
  try {
    url = new URL(redirectUri);
  } catch {
    throw fail("invalid-google-app");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== GOOGLE_CALLBACK || url.search || url.hash || redirectUri.length > 512)
    throw fail("invalid-google-app");
  return { version: 1, clientId, clientSecret, redirectUri };
}

function validateContextPolicy(input) {
  const object = (value) => value && typeof value === "object" && !Array.isArray(value);
  const valid = (shape, value) =>
    object(value) &&
    Object.keys(value).every((key) => Object.hasOwn(shape, key)) &&
    Object.entries(shape).every(([key, rule]) => {
      if (!Array.isArray(rule)) return valid(rule, value[key]);
      const item = value[key];
      if (item === undefined) return rule[1] === null;
      return typeof item === "number" && Number.isFinite(item) && item >= rule[2] && (rule[0] !== "integer" || Number.isSafeInteger(item));
    });
  if (!object(input) || Object.keys(input).length !== 2 || input.version !== 1 || !valid(contextDefinition, input.session))
    throw fail("invalid-context-policy");
  return input;
}

function defaultContextSession(shape = contextDefinition) {
  return Object.fromEntries(
    Object.entries(shape).flatMap(([key, rule]) => (Array.isArray(rule) ? (rule[1] === null ? [] : [[key, rule[1]]]) : [[key, defaultContextSession(rule)]])),
  );
}
const PRIVATE = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
];
class RuntimeManager {
  constructor(config, options = {}) {
    this.config = validateConfig(config);
    this.run = options.run || runCommand;
    this.readinessAttempts = options.readinessAttempts ?? 90;
    this.retryDelay = options.retryDelay ?? 2000;
    this.fetch = options.fetch ?? fetch;
    this.records = new Map();
    this.locks = new Map();
    this.cookies = new Map();
    this.sockets = new Map();
    this.logins = new Map();
    this.grace = new Map();
    secureDir(this.config.rootDir);
    this.token = readPrivate(this.config.tokenFile).trim();
    if (!/^[a-f0-9]{64}$/.test(this.token)) throw fail("invalid-token-file");
    const file = this.config.rootDir + "/runtimes.json";
    if (fs.existsSync(file)) {
      const state = JSON.parse(readPrivate(file));
      if (state.version !== 1 || !Array.isArray(state.runtimes)) throw fail("invalid-state");
      for (const r of state.runtimes) {
        if (
          typeof r.id !== "string" ||
          !UUID.test(r.id) ||
          (r.qqAccount !== undefined && (typeof r.qqAccount !== "string" || !QQ.test(r.qqAccount))) ||
          !["running", "stopped"].includes(r.desired) ||
          (r.plugins !== undefined && !samePlugins(r.plugins)) ||
          (r.patchedFrom !== undefined && (typeof r.patchedFrom !== "string" || !IMAGE_ID.test(r.patchedFrom))) ||
          (r.layout !== undefined && r.layout !== "pod") ||
          (r.podImages !== undefined && !validPodImages(r.podImages)) ||
          this.records.has(r.id)
        )
          throw fail("invalid-state");
        this.records.set(r.id, r);
      }
      const qqs = [...this.records.values()].map((r) => r.qqAccount).filter(Boolean);
      if (new Set(qqs).size !== qqs.length || qqs.includes(this.config.reservedOwnerQQ)) throw fail("invalid-state");
    }
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => this.error(res, e)));
    this.server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head).catch(() => socket.destroy()));
    this.server.on("clientError", (_error, socket) => socket.destroy());
    this.server.requestTimeout = 30000;
    this.server.headersTimeout = 15000;
    this.contextPolicy = { version: 1, session: defaultContextSession() };
    this.googleApp = { version: 1 };
    const savedGoogle = this.config.rootDir + "/google-app.json";
    if (fs.existsSync(savedGoogle)) {
      try {
        this.googleApp = validateGoogleApp(JSON.parse(readPrivate(savedGoogle)));
      } catch {
        process.stderr.write("Saved Google app unreadable; friends see Google as not set up until the owner publishes it again.\n");
      }
    }
    if (this.config.contextPolicyFile) {
      const saved = this.config.rootDir + "/context-policy.json";
      if (fs.existsSync(saved)) this.contextPolicy = validateContextPolicy(JSON.parse(readPrivate(saved)));
      this.syncContextPolicy();
      this.syncGoogleApp();
    }
  }
  authorized(req) {
    const value = req.headers.authorization || "";
    const expected = Buffer.from("Bearer " + this.token),
      actual = Buffer.from(value);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  persist() {
    atomic(this.config.rootDir + "/runtimes.json", { version: 1, runtimes: [...this.records.values()] });
  }
  view(r) {
    return {
      id: r.id,
      state: r.state,
      ...(r.qqAccount ? { qqAccount: r.qqAccount } : {}),
      ...(r.errorCode ? { errorCode: r.errorCode } : {}),
      updatedAt: r.updatedAt,
    };
  }
  update(r, state, errorCode) {
    r.state = state;
    r.errorCode = errorCode;
    r.updatedAt = new Date().toISOString();
    this.persist();
  }
  get(id) {
    if (!UUID.test(id)) throw fail("not-found", 404);
    const r = this.records.get(id);
    if (!r) throw fail("not-found", 404);
    return r;
  }
  names(id) {
    return {
      container: "yesimbot-member-" + id,
      network: "yesimbot-member-" + id,
      bridge: "yb" + id.replaceAll("-", "").slice(0, 12),
      computer: "yesimbot-computer-" + id,
      volume: "yesimbot-computer-" + id,
    };
  }
  assignQQ(r, qq) {
    if (qq === undefined) return;
    if (typeof qq !== "string" || !QQ.test(qq)) throw fail("invalid-qq-account");
    if (qq === this.config.reservedOwnerQQ || [...this.records.values()].some((x) => x.id !== r.id && x.qqAccount === qq)) throw fail("qq-account-in-use", 409);
    if (r.qqAccount && r.qqAccount !== qq) throw fail("qq-account-immutable", 409);
    r.qqAccount = qq;
  }
  register(id, body) {
    if (!UUID.test(id)) throw fail("not-found", 404);
    let r = this.records.get(id);
    if (!r) {
      // Accounts created once the pod images are configured run as separate containers (leave-koishi 6.7).
      r = { id, desired: "stopped", state: "stopped", ...(this.config.pod ? { layout: "pod" } : {}) };
      this.assignQQ(r, body.qqAccount);
      if (body.plugins !== undefined) r.plugins = normalizePlugins(body.plugins);
      this.records.set(id, r);
      this.update(r, "stopped");
    } else {
      this.assignQQ(r, body.qqAccount);
      if (body.plugins !== undefined) r.plugins = normalizePlugins(body.plugins);
      this.update(r, r.state === "setup-required" ? "stopped" : r.state, r.errorCode);
    }
    // Existing runtime directories pick the grant up live through the read-only mount.
    if (fs.existsSync(this.config.rootDir + "/" + id)) this.writePolicy(r);
    return r;
  }
  writePolicy(r) {
    const directory = this.config.rootDir + "/" + r.id + "/policy";
    secureDir(directory);
    // Records predating grants keep every optional plugin; the console rejects anything else.
    atomic(directory + "/plugins.json", { version: 1, plugins: r.plugins ?? OPTIONAL_PLUGINS });
    this.writeContextPolicy(r);
    this.writeGoogleApp(r);
  }
  writeGoogleApp(r) {
    const directory = this.config.rootDir + "/" + r.id + "/policy";
    secureDir(directory);
    const file = directory + "/google.json";
    if (fs.existsSync(file) && readPrivate(file).trim() === JSON.stringify(this.googleApp)) return;
    atomic(file, this.googleApp);
  }
  /** The owner's console writes its app next to the context policy; copy it into every friend's read-only policy. */
  googleAppSource() {
    return this.config.contextPolicyFile
      ? this.config.contextPolicyFile.slice(0, this.config.contextPolicyFile.lastIndexOf("/")) + "/google-app.json"
      : undefined;
  }
  syncGoogleApp() {
    const source = this.googleAppSource();
    if (!source) return;
    try {
      const file = privatePath(source);
      // The owner has never published one: friends see Google as not set up.
      const next = fs.existsSync(file)
        ? (() => {
            const stat = fs.statSync(file);
            if (!stat.isFile() || stat.mode & 0o077 || stat.size > 4096) throw fail("unsafe-google-app");
            return validateGoogleApp(JSON.parse(fs.readFileSync(file, "utf8")));
          })()
        : { version: 1 };
      if (JSON.stringify(next) !== JSON.stringify(this.googleApp)) {
        atomic(this.config.rootDir + "/google-app.json", next);
        this.googleApp = next;
      }
    } catch {
      process.stderr.write("Google app source unavailable; retaining the last valid one.\n");
    }
    for (const r of this.records.values()) if (fs.existsSync(this.config.rootDir + "/" + r.id)) this.writeGoogleApp(r);
  }
  writeContextPolicy(r) {
    const directory = this.config.rootDir + "/" + r.id + "/policy";
    secureDir(directory);
    const file = directory + "/context.json";
    if (fs.existsSync(file) && readPrivate(file).trim() === JSON.stringify(this.contextPolicy)) return;
    atomic(file, this.contextPolicy);
  }
  syncContextPolicy() {
    if (!this.config.contextPolicyFile) return;
    try {
      const file = privatePath(this.config.contextPolicyFile),
        stat = fs.statSync(file);
      // The configured owner application writes this private file; it need not run as root.
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > 8192) throw fail("unsafe-context-policy");
      const next = validateContextPolicy(JSON.parse(fs.readFileSync(file, "utf8")));
      if (JSON.stringify(next) !== JSON.stringify(this.contextPolicy)) {
        atomic(this.config.rootDir + "/context-policy.json", next);
        this.contextPolicy = next;
      }
    } catch {
      if (!this.contextPolicy) throw fail("context-policy-unavailable");
      process.stderr.write("Context policy source unavailable; retaining last valid policy.\n");
    }
    for (const r of this.records.values()) if (fs.existsSync(this.config.rootDir + "/" + r.id)) this.writeContextPolicy(r);
  }
  queue(r, fn) {
    const previous = this.locks.get(r.id) || Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(fn)
      .catch(async () => {
        this.closeSockets(r.id);
        this.cookies.delete(r.id);
        try {
          await this.stopContainer(r);
        } catch {
          /* Never act on foreign containers. */
        }
        this.update(r, "error", "runtime-operation-failed");
      });
    this.locks.set(r.id, task);
    task.finally(() => {
      if (this.locks.get(r.id) === task) this.locks.delete(r.id);
    });
    return task;
  }
  async drain() {
    await Promise.all([...this.locks.values()]);
  }
  start(id, body) {
    const r = this.get(id);
    if (r.deleting) throw fail("runtime-unavailable", 409);
    this.assignQQ(r, body.qqAccount);
    if ((r.appliedQQ ?? "") === (r.qqAccount ?? "") && r.desired === "running" && ["starting", "running"].includes(r.state)) return r;
    r.desired = "running";
    r.retries = 0;
    this.update(r, "starting");
    this.queue(r, () => r.desired === "running" && this.provision(r));
    return r;
  }
  stop(id) {
    const r = this.get(id);
    if (r.deleting) throw fail("runtime-unavailable", 409);
    r.desired = "stopped";
    this.closeSockets(id);
    this.cookies.delete(id);
    this.update(r, "stopping");
    this.queue(r, async () => {
      await this.stopContainer(r);
      this.update(r, "stopped");
    });
    return r;
  }
  async docker(args) {
    return this.run("docker", args);
  }
  async inspect(kind, name) {
    // Listing first distinguishes absence from a daemon/permission failure.
    const ids = String(
      await this.docker(
        kind === "container"
          ? ["ps", "-a", "--filter", "name=^/" + name + "$", "--format", "{{.Names}}"]
          : [kind, "ls", "--filter", "name=^" + name + "$", "--format", "{{.Name}}"],
      ),
    )
      .trim()
      .split("\n");
    if (!ids.includes(name)) return undefined;
    const parsed = JSON.parse(await this.docker([...(kind === "container" ? [] : [kind]), "inspect", name]));
    return parsed[0];
  }
  assertOwned(info, id, network = false) {
    if (info && (network ? info.Labels : info.Config?.Labels)?.[LABEL] !== id) throw fail("foreign-runtime", 409);
  }
  async stopContainer(r) {
    if (r.layout === "pod") return this.stopPod(r);
    const { container } = this.names(r.id);
    const info = await this.inspect("container", container);
    this.assertOwned(info, r.id);
    if (info?.State?.Running) await this.docker(["stop", "--time", "50", container]);
  }
  /** The joined parts first, the namespace's owner last. */
  async stopPod(r) {
    const names = podNames(r.id);
    for (const part of ["wechat", "napcat", "app", "net"]) {
      const info = await this.inspect("container", names[part]);
      this.assertOwned(info, r.id);
      if (info?.State?.Running) await this.docker(["stop", "--time", part === "app" ? "50" : part === "net" ? "10" : "30", names[part]]);
    }
  }
  /** Root-selected host ports a member reaches at its own bridge gateway, plus the device gateway's local entry. */
  hostPorts() {
    const local = this.config.deviceGateway?.localPort;
    return [...new Set([...this.config.hostGatewayPorts, ...(local ? [local] : []), ...(this.config.egress ? [this.config.egress.port] : [])])];
  }
  firewallRules(bridge, hostGateway) {
    const ports = this.hostPorts();
    if (ports.length && !net.isIPv4(hostGateway)) throw fail("unsafe-network");
    return [
      ["INPUT", ["-i", bridge, "-m", "conntrack", "--ctstate", "NEW", "-j", "REJECT"]],
      // Root-selected services are reachable only at this member's own gateway.
      // Inserted after the deny rule so the narrow exception precedes it in INPUT.
      ...ports.map((port) => [
        "INPUT",
        ["-i", bridge, "-d", hostGateway, "-p", "tcp", "--dport", String(port), "-m", "conntrack", "--ctstate", "NEW", "-j", "ACCEPT"],
      ]),
      ...PRIVATE.map((destination) => ["DOCKER-USER", ["-i", bridge, "-d", destination, "-m", "conntrack", "--ctstate", "NEW", "-j", "REJECT"]]),
      // Bridges may have public IP subnets; deny direct inter-tenant forwarding too.
      ["DOCKER-USER", ["-i", bridge, "-o", "yb+", "-m", "conntrack", "--ctstate", "NEW", "-j", "REJECT"]],
    ];
  }
  async firewall(bridge, hostGateway) {
    // Rules only match this freshly created bridge. No global policy changes.
    for (const [chain, args] of this.firewallRules(bridge, hostGateway)) {
      try {
        await this.run("iptables", ["-w", "-C", chain, ...args]);
      } catch {
        await this.run("iptables", ["-w", "-I", chain, "1", ...args]);
      }
    }
  }
  async unfirewall(bridge, hostGateway) {
    // Deleting a member removes exactly the rules its bridge was given, however many copies exist.
    for (const [chain, args] of this.firewallRules(bridge, hostGateway))
      for (let copy = 0; copy < 8; copy++) {
        try {
          await this.run("iptables", ["-w", "-D", chain, ...args]);
        } catch {
          break;
        }
      }
  }
  /** A root-selected image as the immutable ID containers are created from. */
  async imageId(reference) {
    const id = JSON.parse(await this.docker(["image", "inspect", reference]))[0]?.Id;
    if (!IMAGE_ID.test(id ?? "")) throw fail("image-unavailable", 502);
    return id;
  }
  async provision(r) {
    if (r.layout === "pod") return this.provisionPod(r);
    const { container } = this.names(r.id);
    // Resolve the root-selected image to an immutable ID for this container.
    const image = await this.imageId(this.config.image);
    const { directory, network, bridge, hostGateway, localGateway, gateway } = await this.prepareRuntime(r);
    let c = await this.inspect("container", container);
    this.assertOwned(c, r.id);
    // A stopped container on neither the pinned nor the in-place patched image is stale; all state is in bind mounts.
    if (c && !c.State?.Running && c.Image !== image && c.Image !== r.patchedFrom) {
      await this.docker(["rm", container]);
      c = undefined;
    }
    if (c) {
      this.validateContainer(c, r, image, directory, network);
      const currentQQ = c.Config?.Env?.find((value) => value.startsWith("QQ_ACCOUNT="))?.slice(11) ?? "";
      const currentGateway = c.Config?.Env?.find((value) => value.startsWith("YESIMBOT_DEVICE_GATEWAY="))?.slice("YESIMBOT_DEVICE_GATEWAY=".length) ?? "";
      const currentLocal =
        c.Config?.Env?.find((value) => value.startsWith("YESIMBOT_DEVICE_LOCAL_GATEWAY="))?.slice("YESIMBOT_DEVICE_LOCAL_GATEWAY=".length) ?? "";
      if (currentQQ !== (r.qqAccount ?? "") || currentGateway !== (gateway?.origin ?? "") || currentLocal !== localGateway) {
        if (c.State?.Running) await this.docker(["stop", "--time", "50", container]);
        await this.docker(["rm", container]);
        c = undefined;
      }
    }
    await this.openNetwork(directory, bridge, hostGateway);
    if (!c) {
      // A container created from the pin carries exactly the pinned code again.
      delete r.patchedFrom;
      const caps = this.config.caps;
      const args = [
        "create",
        "--name",
        container,
        "--label",
        LABEL + "=" + r.id,
        "--restart",
        "no",
        "--network",
        network,
        "--publish",
        "127.0.0.1::5140",
        "--cpus",
        String(caps.cpus),
        "--memory",
        caps.memoryMB + "m",
        "--memory-swap",
        caps.memoryMB + "m",
        "--pids-limit",
        String(caps.pids),
        "--shm-size",
        caps.shmMB + "m",
        "--log-driver",
        "json-file",
        "--log-opt",
        "max-size=10m",
        "--log-opt",
        "max-file=2",
        "--security-opt",
        "no-new-privileges:true",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "CHOWN",
        "--cap-add",
        "SETUID",
        "--cap-add",
        "SETGID",
        "--cap-add",
        "DAC_OVERRIDE",
        "--cap-add",
        "FOWNER",
        "--cap-add",
        "KILL",
        "--sysctl",
        "net.ipv6.conf.all.disable_ipv6=1",
      ];
      for (const value of this.appEnv(r, gateway, localGateway)) args.push("--env", value);
      for (const [part, target] of MOUNTS)
        args.push("--mount", "type=bind,src=" + directory + "/" + part + ",dst=" + target + (READONLY.has(target) ? ",readonly" : ""));
      args.push(image);
      await this.docker(args);
    }
    c = await this.inspect("container", container);
    this.assertOwned(c, r.id);
    this.validateContainer(c, r, image, directory, network);
    if (r.desired !== "running") return;
    // Recover management of an already validated running instance without interrupting it.
    if (!c.State?.Running) await this.docker(["start", container]);
    c = await this.inspect("container", container);
    this.assertOwned(c, r.id);
    this.validateContainer(c, r, image, directory, network);
    const mapping = c?.NetworkSettings?.Ports?.["5140/tcp"];
    if (!Array.isArray(mapping) || mapping.length !== 1 || mapping[0].HostIp !== "127.0.0.1" || !/^[0-9]+$/.test(mapping[0].HostPort))
      throw fail("unsafe-port");
    r.port = Number(mapping[0].HostPort);
    if (r.port < 1024 || r.port > 65535) throw fail("unsafe-port");
    this.persist();
    this.cookies.delete(r.id);
    for (let attempt = 0; attempt < this.readinessAttempts; attempt++) {
      if (r.desired !== "running") return;
      try {
        await this.cookie(r);
        r.appliedQQ = r.qqAccount ?? "";
        this.update(r, "running");
        return;
      } catch {
        await sleep(this.retryDelay);
      }
    }
    await this.stopContainer(r);
    throw fail("runtime-not-ready", 502);
  }
  /** The member's directories, policy, credentials and private network, shared by both layouts. */
  async prepareRuntime(r) {
    const { network, bridge } = this.names(r.id);
    const directory = this.config.rootDir + "/" + r.id;
    secureDir(directory);
    for (const part of ["koishi", "qq", "napcat-config", "napcat-plugins"]) secureDir(directory + "/" + part);
    this.writePolicy(r);
    const gateway = this.config.deviceGateway;
    if (gateway) {
      await this.run(process.execPath, [
        gateway.cli,
        "ensure-runtime",
        "--state",
        gateway.stateDir,
        "--tenant",
        r.id,
        "--output",
        directory + "/policy/device-credential.json",
      ]);
      const credential = JSON.parse(readPrivate(directory + "/policy/device-credential.json"));
      if (credential.version !== 1 || credential.tenantId !== r.id || !/^[a-f0-9]{64}$/.test(credential.token)) throw fail("invalid-device-credential");
    }
    const passwordFile = directory + "/backend-password";
    if (!fs.existsSync(passwordFile)) fs.writeFileSync(passwordFile, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    const password = readPrivate(passwordFile).trim();
    if (!/^[a-f0-9]{64}$/.test(password)) throw fail("invalid-state");
    let n = await this.inspect("network", network);
    this.assertOwned(n, r.id, true);
    if (!n) {
      await this.docker([
        "network",
        "create",
        "--driver",
        "bridge",
        "--label",
        LABEL + "=" + r.id,
        "--opt",
        "com.docker.network.bridge.name=" + bridge,
        "--opt",
        "com.docker.network.bridge.enable_icc=false",
        network,
      ]);
      n = await this.inspect("network", network);
      this.assertOwned(n, r.id, true);
    }
    if (
      !n ||
      n.Driver !== "bridge" ||
      n.EnableIPv6 ||
      n.Options?.["com.docker.network.bridge.name"] !== bridge ||
      n.Options?.["com.docker.network.bridge.enable_icc"] !== "false"
    )
      throw fail("unsafe-network");
    const hostGateway = n.IPAM?.Config?.find((entry) => net.isIPv4(entry.Gateway))?.Gateway;
    // The device gateway as this member sees it on its own bridge; the public origin stays its fallback.
    // Only a private bridge address qualifies (the container's init refuses anything else); otherwise the public origin alone.
    const privateBridge = net.isIPv4(hostGateway ?? "") && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostGateway);
    const localGateway = gateway?.localPort && privateBridge ? "http://" + hostGateway + ":" + gateway.localPort : "";
    return { directory, network, bridge, hostGateway, localGateway, gateway };
  }
  /** The egress policy and the bridge's firewall, before anything on it starts. */
  async openNetwork(directory, bridge, hostGateway) {
    if (this.config.egress)
      atomic(directory + "/policy/network.json", { proxy: `http://${hostGateway}:${this.config.egress.port}`, directHosts: this.config.egress.directHosts });
    await this.firewall(bridge, hostGateway);
  }
  /** The app's environment, the same in both layouts. */
  appEnv(r, gateway, localGateway) {
    return [
      "YESIMBOT_TENANT_ID=" + r.id,
      "QQ_ACCOUNT=" + (r.qqAccount ?? ""),
      "ADMIN_PUBLIC_ORIGIN=" + this.config.publicOrigin,
      "ADMIN_ADDITIONAL_ORIGINS_JSON=" + JSON.stringify(this.config.additionalOrigins),
      "ADMIN_PASSWORD_FILE=/run/secrets/admin-password",
      ...(gateway
        ? [
            "YESIMBOT_DEVICE_GATEWAY=" + gateway.origin,
            "YESIMBOT_DEVICE_CREDENTIAL_FILE=" + POLICY_TARGET + "/device-credential.json",
            ...(localGateway ? ["YESIMBOT_DEVICE_LOCAL_GATEWAY=" + localGateway] : []),
          ]
        : []),
    ];
  }
  /**
   * An account as separate containers (runtime-pod.mjs): `net` first, then the app until it answers, then NapCat and
   * agent-wechat, whose settings and token the app's init writes. Each part restarts alone; a part that joined an
   * earlier start of `net` restarts so it is on the current namespace.
   */
  async provisionPod(r) {
    const pod = this.config.pod;
    if (!pod) throw fail("invalid-config");
    const pins = { app: await this.imageId(pod.app), napcat: await this.imageId(pod.napcat), wechat: await this.imageId(pod.wechat) };
    pins.net = pins.wechat;
    const { directory, network, bridge, hostGateway, localGateway, gateway } = await this.prepareRuntime(r);
    secureDir(directory + "/koishi/data/agent-wechat");
    const env = { app: this.appEnv(r, gateway, localGateway), napcat: ["ACCOUNT=" + (r.qqAccount ?? ""), "NAPCAT_CONFIG_DIR=/app/napcat/config"] };
    const context = { r, config: this.config, directory, network, wrapper: napcatWrapper(), env };
    const names = podNames(r.id);
    // NapCat runs only for a QQ account.
    if (!r.qqAccount) await this.removePart(r, names.napcat);
    let net = await this.ensurePart(r, podSpec("net", { ...context, netId: "" }), pins.net);
    await this.openNetwork(directory, bridge, hostGateway);
    if (!net.State?.Running) await this.docker(["start", names.net]);
    net = await this.checkedPart(r, podSpec("net", { ...context, netId: "" }), pins.net);
    const mapping = net.NetworkSettings?.Ports?.["5140/tcp"];
    if (!Array.isArray(mapping) || mapping.length !== 1 || mapping[0].HostIp !== "127.0.0.1" || !/^[0-9]+$/.test(mapping[0].HostPort))
      throw fail("unsafe-port");
    r.port = Number(mapping[0].HostPort);
    if (r.port < 1024 || r.port > 65535) throw fail("unsafe-port");
    this.persist();
    const joined = (part) => podSpec(part, { ...context, netId: net.Id });
    await this.runPart(r, joined("app"), pins.app, net);
    this.cookies.delete(r.id);
    let ready = false;
    for (let attempt = 0; attempt < this.readinessAttempts && !ready; attempt++) {
      if (r.desired !== "running") return;
      try {
        await this.cookie(r);
        ready = true;
      } catch {
        await sleep(this.retryDelay);
      }
    }
    if (!ready) {
      await this.stopContainer(r);
      throw fail("runtime-not-ready", 502);
    }
    for (const part of podParts(r).filter((name) => name === "napcat" || name === "wechat")) await this.runPart(r, joined(part), pins[part], net);
    r.appliedQQ = r.qqAccount ?? "";
    this.update(r, "running");
  }
  /**
   * The part's container, created when missing. One made for another namespace, for other settings, or (stopped) from
   * an older image is recreated; its state is all in bind mounts. A running one that is otherwise not what the spec
   * says is never touched.
   */
  async ensurePart(r, spec, pin) {
    let c = await this.inspect("container", spec.name);
    this.assertOwned(c, r.id);
    const own = c?.Config?.Labels?.[PART_LABEL] === spec.part;
    if (c && (!own || c.HostConfig?.NetworkMode !== spec.networkMode || podEnvDrift(c, spec) || (!c.State?.Running && c.Image !== pin))) {
      await this.removePart(r, spec.name);
      c = undefined;
    }
    if (!c) {
      await this.docker(podCreateArgs(spec, { id: r.id, image: pin }));
      if (spec.part === "app") delete r.patchedFrom;
      else r.podImages = { ...r.podImages, [spec.part]: pin };
      this.persist();
    }
    return this.checkedPart(r, spec, pin);
  }
  async checkedPart(r, spec, pin) {
    const c = await this.inspect("container", spec.name);
    this.assertOwned(c, r.id);
    // The app may run an in-place patched image (deploy_preview.py); the others, the image they were created from.
    const images = [pin, ...(spec.part === "app" ? [r.patchedFrom] : [r.podImages?.[spec.part]])].filter(Boolean);
    if (!validPodContainer(c, spec, r.id, images)) throw fail("unsafe-container");
    return c;
  }
  async runPart(r, spec, pin, net) {
    const c = await this.ensurePart(r, spec, pin);
    if (c.State?.Running && staleJoin(c, net)) await this.docker(["restart", "--time", "30", spec.name]);
    else if (!c.State?.Running) await this.docker(["start", spec.name]);
    return this.checkedPart(r, spec, pin);
  }
  async removePart(r, name) {
    const c = await this.inspect("container", name);
    this.assertOwned(c, r.id);
    if (!c) return;
    if (c.State?.Running) await this.docker(["stop", "--time", "30", name]);
    await this.docker(["rm", name]);
  }
  /** Changing an account's layout (stage 7, and its rollback): the old containers go, the data stays. */
  relayout(id, body) {
    const r = this.get(id);
    if (r.deleting) throw fail("runtime-unavailable", 409);
    if (body.layout !== "pod" && body.layout !== "single") throw fail("invalid-request");
    if (body.layout === "pod" && !this.config.pod) throw fail("invalid-request");
    if ((r.layout ?? "single") === body.layout) return r;
    this.closeSockets(id);
    this.cookies.delete(id);
    this.update(r, r.desired === "running" ? "starting" : "stopping");
    this.queue(r, async () => {
      await this.stopContainer(r);
      const names = r.layout === "pod" ? Object.values(podNames(r.id)) : [this.names(r.id).container];
      for (const name of names) await this.removePart(r, name);
      if (body.layout === "pod") r.layout = "pod";
      else delete r.layout;
      delete r.patchedFrom;
      delete r.podImages;
      this.persist();
      if (r.desired === "running") await this.provision(r);
      else this.update(r, "stopped");
    });
    return r;
  }
  /** The tenant's gateway session, used only to revoke devices during explicit account deletion. */
  async gatewayRequest(token, method, path) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw fail("invalid-device-credential");
    const port = this.config.deviceGateway?.controlPort;
    if (!port) throw fail("invalid-config");
    const response = await this.fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: "Bearer " + token },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok && response.status !== 404) throw fail("device-gateway-unavailable", 502);
    const text = await response.text();
    if (text.length > 262144) throw fail("device-gateway-unavailable", 502);
    return response.status === 404 ? undefined : JSON.parse(text);
  }
  async revokeDevices(r, ids) {
    const file = this.config.rootDir + "/" + r.id + "/policy/device-credential.json";
    if (!fs.existsSync(file)) return;
    const { token } = JSON.parse(readPrivate(file));
    const devices = ids ?? ((await this.gatewayRequest(token, "GET", "/v1/devices")) ?? []).filter((d) => d.revokedAt === undefined).map((d) => d.deviceId);
    for (const id of devices) if (UUID.test(id)) await this.gatewayRequest(token, "DELETE", "/v1/devices/" + id);
  }
  remove(id) {
    const r = this.get(id);
    r.deleting = true;
    r.desired = "stopped";
    this.closeSockets(id);
    this.cookies.delete(id);
    this.update(r, "deleting");
    this.queue(r, () => this.destroy(r));
    return r;
  }
  /** Deleting a friend: both containers, the computer's disk, devices, credentials, network, firewall and data go. */
  async destroy(r) {
    const { container, computer, network, bridge, volume } = this.names(r.id);
    const pod = podNames(r.id);
    for (const name of [computer, pod.wechat, pod.napcat, container, pod.net]) {
      const info = await this.inspect("container", name);
      this.assertOwned(info, r.id);
      if (info?.State?.Running) await this.docker(["stop", "--time", "10", name]);
      if (info) await this.docker(["rm", name]);
    }
    const v = await this.inspect("volume", volume);
    this.assertOwned(v, r.id, true);
    if (v) await this.docker(["volume", "rm", volume]);
    const directory = this.config.rootDir + "/" + r.id;
    const disk = directory + "/computer/disk.img";
    if (fs.existsSync(disk))
      for (const line of String(await this.run("losetup", ["-j", disk]))
        .trim()
        .split("\n")) {
        const device = /^(\/dev\/loop[0-9]+):/.exec(line)?.[1];
        if (device) await this.run("losetup", ["-d", device]);
      }
    const gateway = this.config.deviceGateway;
    if (gateway) {
      // Devices first (they need the tenant's session), then the session itself.
      if (gateway.controlPort) await this.revokeDevices(r).catch(() => process.stderr.write("Device revocation for " + r.id + " was incomplete.\n"));
      await this.run(process.execPath, [gateway.cli, "revoke-runtime", "--state", gateway.stateDir, "--tenant", r.id]);
    }
    const n = await this.inspect("network", network);
    this.assertOwned(n, r.id, true);
    if (n) {
      const hostGateway = n.IPAM?.Config?.find((entry) => net.isIPv4(entry.Gateway))?.Gateway;
      await this.unfirewall(bridge, hostGateway);
      await this.docker(["network", "rm", network]);
    }
    privatePath(directory);
    fs.rmSync(directory, { recursive: true, force: true });
    this.records.delete(r.id);
    this.cookies.delete(r.id);
    this.persist();
  }
  validateContainer(c, r, image, directory, network) {
    if (
      !c ||
      (c.Image !== image && c.Image !== r.patchedFrom) ||
      c.HostConfig?.Privileged ||
      c.HostConfig?.PidMode ||
      c.HostConfig?.NetworkMode !== network ||
      c.HostConfig?.RestartPolicy?.Name !== "no"
    )
      throw fail("unsafe-container");
    const h = c.HostConfig,
      caps = this.config.caps;
    const allowedCaps = ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER", "KILL"];
    // Docker Engine versions may canonicalize/sort these as CAP_CHOWN etc.
    const actualCaps = Array.isArray(h.CapAdd) ? h.CapAdd.map((value) => (typeof value === "string" ? value.toUpperCase().replace(/^CAP_/, "") : "")) : [];
    if (
      !h.CapDrop?.includes("ALL") ||
      actualCaps.length !== allowedCaps.length ||
      new Set(actualCaps).size !== allowedCaps.length ||
      actualCaps.some((x) => !allowedCaps.includes(x)) ||
      !h.SecurityOpt?.includes("no-new-privileges:true") ||
      h.Sysctls?.["net.ipv6.conf.all.disable_ipv6"] !== "1" ||
      h.NanoCpus !== caps.cpus * 1e9 ||
      h.Memory !== caps.memoryMB * 1024 * 1024 ||
      h.MemorySwap !== h.Memory ||
      h.PidsLimit !== caps.pids ||
      h.ShmSize !== caps.shmMB * 1024 * 1024 ||
      h.LogConfig?.Type !== "json-file" ||
      h.LogConfig?.Config?.["max-size"] !== "10m" ||
      h.LogConfig?.Config?.["max-file"] !== "2" ||
      h.Binds?.length ||
      h.Devices?.length ||
      h.DeviceRequests?.length ||
      h.VolumesFrom?.length ||
      h.ExtraHosts?.length ||
      h.Links?.length
    )
      throw fail("unsafe-container");
    if (Object.keys(h.PortBindings || {}).length !== 1 || h.PortBindings["5140/tcp"]?.length !== 1 || h.PortBindings["5140/tcp"][0].HostIp !== "127.0.0.1")
      throw fail("unsafe-container");
    if (!sameMounts(c, directory, MOUNTS)) throw fail("unsafe-container");
    if (
      Object.keys(c.HostConfig?.PortBindings || {}).some((k) => k !== "5140/tcp") ||
      Object.keys(c.NetworkSettings?.Networks || {}).some((k) => k !== network)
    )
      throw fail("unsafe-container");
  }
  async reconcile() {
    for (const r of this.records.values()) {
      this.closeSockets(r.id);
      this.cookies.delete(r.id);
      if (r.deleting) this.queue(r, () => this.destroy(r));
      else if (r.desired === "running") {
        this.update(r, "starting");
        this.queue(r, () => this.provision(r));
      } else {
        this.queue(r, async () => {
          await this.stopContainer(r);
          this.update(r, "stopped");
        });
      }
    }
  }
  async monitor() {
    for (const r of this.records.values())
      if (r.desired === "running" && r.state === "running" && !this.locks.has(r.id) && (this.grace.get(r.id) ?? 0) <= Date.now()) {
        this.queue(r, async () => {
          if (!(await this.healthy(r))) {
            this.closeSockets(r.id);
            r.retries = (r.retries || 0) + 1;
            if (r.retries > 3) {
              await this.stopContainer(r);
              this.update(r, "error", "runtime-operation-failed");
              return;
            }
            this.update(r, "starting");
            await this.provision(r);
          }
        });
      }
  }
  /** Whether every container the account runs is up and the app is not unhealthy. */
  async healthy(r) {
    const names = r.layout === "pod" ? podParts(r).map((part) => podNames(r.id)[part]) : [this.names(r.id).container];
    for (const name of names) {
      const c = await this.inspect("container", name);
      this.assertOwned(c, r.id);
      if (!c?.State?.Running || c.State.Health?.Status === "unhealthy") return false;
    }
    return true;
  }
  async cookie(r) {
    const cached = this.cookies.get(r.id);
    if (cached && cached.expiry > Date.now()) return cached.value;
    if (this.logins.has(r.id)) return this.logins.get(r.id);
    const task = this.loginCookie(r).finally(() => this.logins.delete(r.id));
    this.logins.set(r.id, task);
    return task;
  }
  async loginCookie(r) {
    const password = readPrivate(
      this.config.externalRuntimes.find((item) => item.id === r.id)?.passwordFile ?? this.config.rootDir + "/" + r.id + "/backend-password",
    ).trim();
    const body = JSON.stringify({ username: "admin", password });
    const cookie = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: r.port,
          path: "/yesimbot/admin/login",
          method: "POST",
          headers: {
            host: new URL(this.config.publicOrigin).host,
            origin: this.config.publicOrigin,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          const values = res.headers["set-cookie"];
          if (res.statusCode !== 200 || !values?.length) return reject(fail("backend-auth-failed", 502));
          resolve(values.map((v) => v.split(";")[0]).join("; "));
        },
      );
      req.setTimeout(10000, () => req.destroy());
      req.on("error", () => reject(fail("backend-unavailable", 502)));
      req.end(body);
    });
    if (r.desired === "running") this.cookies.set(r.id, { value: cookie, expiry: Date.now() + 3600000 });
    return cookie;
  }
  /** Runs fn under the member's lock like queue(), but hands back its result and never stops the container on failure. */
  exclusive(r, fn) {
    const previous = this.locks.get(r.id) || Promise.resolve();
    const result = previous.catch(() => {}).then(fn);
    const task = result.catch(() => {});
    this.locks.set(r.id, task);
    task.finally(() => {
      if (this.locks.get(r.id) === task) this.locks.delete(r.id);
    });
    return result;
  }
  async supervisor(container, ...args) {
    return String(await this.docker(["exec", container, "/usr/bin/supervisorctl", ...SUPERVISOR, ...args]));
  }
  /** One instance for the ops view. Every failing probe only drops its own field. */
  async opsInstance(target, container, info) {
    const running = Boolean(info?.State?.Running);
    const instance = {
      target,
      container: { name: container, running, ...(running && info.State.StartedAt ? { startedAt: info.State.StartedAt } : {}) },
      programs: {},
    };
    if (!running) return instance;
    const [stats, status, release] = await Promise.all([
      this.docker(["stats", "--no-stream", "--format", "{{json .}}", container]).then(parseStats, () => undefined),
      // supervisorctl exits 3 while any program is down; the table is still the answer.
      this.docker(["exec", container, "sh", "-c", `/usr/bin/supervisorctl ${SUPERVISOR.join(" ")} status || true`]).then(parseSupervisor, () => ({})),
      this.docker(["exec", container, "cat", RELEASE_FILE]).then(parseRelease, () => undefined),
    ]);
    if (stats?.memory) instance.memory = stats.memory;
    if (stats?.cpuPercent !== undefined) instance.cpuPercent = stats.cpuPercent;
    instance.programs = status;
    if (release) instance.release = release;
    return instance;
  }
  async opsOwner() {
    const { container } = this.config.owner;
    return this.opsInstance("owner", container, await this.inspect("container", container));
  }
  async opsMember(r) {
    const { container } = this.names(r.id);
    const info = await this.inspect("container", container);
    this.assertOwned(info, r.id);
    const instance = await this.opsInstance(r.id, container, info);
    if (r.layout !== "pod") return instance;
    // NapCat is its own container: its state is that container's, and the account's use adds every part's.
    const names = podNames(r.id);
    const parts = {};
    for (const part of ["napcat", "wechat"]) {
      parts[part] = await this.inspect("container", names[part]);
      this.assertOwned(parts[part], r.id);
    }
    delete instance.programs.napcat;
    if (r.qqAccount) instance.programs.napcat = containerProgram(parts.napcat);
    for (const part of ["napcat", "wechat"]) {
      if (!parts[part]?.State?.Running) continue;
      const stats = await this.docker(["stats", "--no-stream", "--format", "{{json .}}", names[part]]).then(parseStats, () => undefined);
      if (stats?.memory && instance.memory)
        instance.memory = { usedBytes: instance.memory.usedBytes + stats.memory.usedBytes, limitBytes: instance.memory.limitBytes + stats.memory.limitBytes };
      if (stats?.cpuPercent !== undefined && instance.cpuPercent !== undefined) instance.cpuPercent += stats.cpuPercent;
    }
    return instance;
  }
  async ops() {
    const instances = await Promise.all([
      ...(this.config.owner ? [this.opsOwner()] : []),
      ...[...this.records.values()].map((r) =>
        this.opsMember(r).catch(() => ({ target: r.id, container: { name: this.names(r.id).container, running: false }, programs: {} })),
      ),
    ]);
    return { generatedAt: new Date().toISOString(), instances };
  }
  async restartOps(req, res, target) {
    const { program } = await jsonBody(req, ["program"]);
    if (program !== "koishi" && program !== "napcat") throw fail("invalid-request");
    if (target === "owner") {
      if (!this.config.owner) throw fail("not-found", 404);
      const { container } = this.config.owner;
      if (program === "napcat") {
        await this.supervisor(container, "restart", "napcat");
        return this.json(res, 200, { instance: await this.opsOwner() });
      }
      // The caller is this Koishi: answer first, then restart it.
      this.json(res, 202, { accepted: true });
      res.once("close", () => {
        this.supervisor(container, "restart", "koishi").catch(() => process.stderr.write("Owner Koishi restart failed.\n"));
      });
      return;
    }
    const r = this.get(target);
    const available = () => !r.deleting && r.desired === "running" && r.state === "running";
    if (!available()) throw fail("runtime-unavailable", 409);
    await this.exclusive(r, async () => {
      if (!available()) throw fail("runtime-unavailable", 409);
      const { container } = this.names(r.id);
      const info = await this.inspect("container", container);
      this.assertOwned(info, r.id);
      if (!info?.State?.Running) throw fail("runtime-unavailable", 409);
      // Docker's health lags a restart; keep monitor() from reading that as a crash.
      this.grace.set(r.id, Date.now() + RESTART_GRACE_MS);
      try {
        if (program === "napcat" && r.layout === "pod") {
          const napcat = podNames(r.id).napcat;
          const c = await this.inspect("container", napcat);
          this.assertOwned(c, r.id);
          if (!c) throw fail("runtime-unavailable", 409);
          await this.docker(["restart", "--time", "30", napcat]);
        } else await this.supervisor(container, "restart", program);
        if (program === "koishi") {
          this.closeSockets(r.id);
          this.cookies.delete(r.id);
          let ready = false;
          for (let attempt = 0; attempt < this.readinessAttempts && !ready; attempt++) {
            if (!available()) throw fail("runtime-unavailable", 409);
            try {
              await this.cookie(r);
              ready = true;
            } catch {
              await sleep(this.retryDelay);
            }
          }
          if (!ready) throw fail("runtime-not-ready", 502);
        }
      } finally {
        this.grace.set(r.id, Date.now() + RESTART_GRACE_MS);
      }
    });
    this.json(res, 200, { instance: await this.opsMember(r) });
  }
  json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }
  error(res, e) {
    if (res.headersSent) return res.destroy();
    this.json(res, e.status || 502, {
      errorCode: [
        "not-found",
        "unauthorized",
        "invalid-request",
        "invalid-qq-account",
        "qq-account-in-use",
        "qq-account-immutable",
        "qq-account-required",
        "runtime-unavailable",
      ].includes(e.code)
        ? e.code
        : "runtime-operation-failed",
    });
  }
  async handle(req, res) {
    if (!this.authorized(req)) return this.json(res, 401, { errorCode: "unauthorized" });
    const pathname = req.url?.split("?")[0];
    if (req.method === "GET" && pathname === "/health") return this.json(res, 200, { ok: true });
    if (req.method === "GET" && pathname === "/v1/runtimes") return this.json(res, 200, { runtimes: [...this.records.values()].map((r) => this.view(r)) });
    if (req.method === "GET" && pathname === "/v1/ops") return this.json(res, 200, await this.ops());
    const restart = /^\/v1\/ops\/(owner|[^/]+)\/restart$/.exec(pathname || "");
    if (restart) {
      if (req.method !== "POST" || (restart[1] !== "owner" && !UUID.test(restart[1]))) throw fail("not-found", 404);
      return this.restartOps(req, res, restart[1]);
    }
    const match = /^\/v1\/runtimes\/([^/]+)(?:\/(start|stop|http|layout)(\/.*)?)?$/.exec(pathname || "");
    if (!match || !UUID.test(match[1])) throw fail("not-found", 404);
    const [, id, action] = match;
    const external = this.config.externalRuntimes.find((item) => item.id === id);
    if (external) return this.handleExternal(req, res, external, action, match[3]);
    if (action === "http" && match[3]) {
      const r = this.get(id);
      if (r.state !== "running" || r.desired !== "running") throw fail("runtime-unavailable", 409);
      const offset = req.url.indexOf("/http/") + 5,
        target = req.url.slice(offset);
      if (!target.startsWith("/") || target.startsWith("//") || /[\\\r\n]/.test(target) || /%(?:2f|5c|0[ad])/i.test(target.split("?")[0]))
        throw fail("invalid-request");
      return this.relay(req, res, r, target);
    }
    if (match[3]) throw fail("not-found", 404);
    let r;
    if (req.method === "PUT" && !action) r = this.register(id, await jsonBody(req));
    else if (req.method === "GET" && !action) r = this.get(id);
    else if (req.method === "DELETE" && !action) r = this.remove(id);
    else if (req.method === "POST" && action === "start") r = this.start(id, withoutPlugins(await jsonBody(req)));
    else if (req.method === "POST" && action === "layout") r = this.relayout(id, await jsonBody(req, ["layout"]));
    else if (req.method === "POST" && action === "stop") {
      withoutPlugins(await jsonBody(req));
      r = this.stop(id);
    } else throw fail("not-found", 404);
    this.json(res, 200, { runtime: this.view(r) });
  }
  async relay(req, res, r, path) {
    const cookie = await this.cookie(r);
    if (r.state !== "running" || r.desired !== "running") throw fail("runtime-unavailable", 409);
    const proxy = http.request(
      {
        host: "127.0.0.1",
        port: r.port,
        path,
        method: req.method,
        headers: {
          ...headers(req.headers),
          ...chatIdentityHeaders(req.headers, path, cookie),
          ...desktopIdentityHeaders(req.headers, path, cookie),
          host: new URL(this.config.publicOrigin).host,
          origin: this.config.publicOrigin,
          cookie,
        },
      },
      (backend) => {
        if (backend.statusCode === 401) this.cookies.delete(r.id);
        res.writeHead(backend.statusCode || 502, { ...headers(backend.headers), "cache-control": "no-store" });
        backend.on("error", () => res.destroy());
        backend.pipe(res);
      },
    );
    this.track(r.id, proxy);
    proxy.setTimeout(120000, () => proxy.destroy());
    proxy.on("error", () => this.error(res, fail("backend-unavailable", 502)));
    req.on("aborted", () => proxy.destroy());
    res.on("close", () => proxy.destroy());
    req.pipe(proxy);
  }
  track(id, ...sockets) {
    let set = this.sockets.get(id);
    if (!set) this.sockets.set(id, (set = new Set()));
    for (const s of sockets) {
      set.add(s);
      s.on("close", () => {
        set.delete(s);
        if (!set.size) this.sockets.delete(id);
      });
    }
  }
  closeSockets(id) {
    for (const s of this.sockets.get(id) || []) s.destroy();
    this.sockets.delete(id);
  }
  async upgrade(req, socket, head) {
    if (!this.authorized(req)) return socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    const match = /^\/v1\/runtimes\/([^/]+)\/(ws|onebot|desktop)$/.exec(req.url || "");
    if (!match || req.headers.upgrade?.toLowerCase() !== "websocket") return socket.destroy();
    const external = this.config.externalRuntimes.find((item) => item.id === match[1]);
    const onebot = match[2] === "onebot";
    if (
      onebot &&
      (!external ||
        !/^[1-9][0-9]{4,14}$/.test(String(req.headers["x-self-id"] ?? "")) ||
        !["Universal", "Event", "API"].includes(String(req.headers["x-client-role"] ?? "")))
    )
      return socket.destroy();
    const r = external ? await this.externalRecord(external) : this.get(match[1]);
    if (r.state !== "running" || r.desired !== "running") return socket.destroy();
    const cookie = onebot ? undefined : await this.cookie(r);
    if (r.desired !== "running") return socket.destroy();
    const upstream = http.request({
      host: "127.0.0.1",
      port: r.port,
      path: onebot ? "/onebot" : match[2] === "desktop" ? "/yesimbot/api/v1/devices/desktop" : "/yesimbot/runtime/status",
      headers: {
        ...headers(req.headers, true),
        ...(match[2] === "desktop" ? desktopIdentityHeaders(req.headers, "/yesimbot/api/v1/devices/desktop", cookie) : {}),
        host: new URL(this.config.publicOrigin).host,
        ...(onebot ? { "x-self-id": req.headers["x-self-id"], "x-client-role": req.headers["x-client-role"] } : { origin: this.config.publicOrigin, cookie }),
      },
    });
    this.track(r.id, socket);
    upstream.setTimeout(15000, () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    upstream.on("response", (res) => {
      res.resume();
      socket.destroy();
    });
    upstream.on("upgrade", (res, backend, backendHead) => {
      upstream.setTimeout(0);
      backend.setTimeout(0);
      if (r.desired !== "running" || socket.destroyed || res.statusCode !== 101) {
        backend.destroy();
        socket.destroy();
        return;
      }
      this.track(r.id, backend);
      const responseHeaders = headers(res.headers, true);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          Object.entries(responseHeaders)
            .map(([k, v]) => `${k}: ${v}\r\n`)
            .join("") +
          "\r\n",
      );
      if (backendHead.length) socket.write(backendHead);
      if (head.length) backend.write(head);
      backend.on("error", () => socket.destroy());
      socket.on("error", () => backend.destroy());
      backend.on("close", () => socket.destroy());
      socket.on("close", () => backend.destroy());
      socket.pipe(backend);
      backend.pipe(socket);
    });
    upstream.end();
  }
  async listen() {
    await this.reconcile();
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, this.config.bindHost, resolve);
    });
    this.timer = setInterval(() => this.monitor().catch(() => {}), 30000);
    this.timer.unref();
    this.contextTimer = setInterval(() => {
      try {
        this.syncContextPolicy();
        this.syncGoogleApp();
        void this.syncExternalPolicies();
      } catch {
        process.stderr.write("Context policy synchronization failed.\n");
      }
    }, 5000);
    this.contextTimer.unref();
    void this.syncExternalPolicies();
  }

  async externalRequest(external, path, method = "GET", body) {
    const token = readPrivate(external.tokenFile).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw fail("invalid-config");
    const response = await fetch(`http://127.0.0.1:${external.controlPort}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw fail("runtime-unavailable", 503);
    const text = await response.text();
    if (text.length > 16384) throw fail("runtime-unavailable", 503);
    return JSON.parse(text);
  }
  async externalRecord(external) {
    const { runtime } = await this.externalRequest(external, "/runtime");
    if (runtime?.id !== external.id || !["starting", "running", "stopping", "stopped", "error"].includes(runtime.state)) throw fail("runtime-unavailable", 503);
    return {
      id: external.id,
      state: runtime.state,
      desired: runtime.state === "running" ? "running" : "stopped",
      port: external.backendPort,
      updatedAt: typeof runtime.updatedAt === "string" ? runtime.updatedAt : undefined,
      location: "local",
      name: external.name,
      version: typeof runtime.version === "string" ? runtime.version.slice(0, 100) : undefined,
      policyVersion: typeof runtime.policyVersion === "string" && /^[a-f0-9]{64}$/.test(runtime.policyVersion) ? runtime.policyVersion : undefined,
    };
  }
  async handleExternal(req, res, external, action, suffix) {
    if (action === "http" && suffix) {
      const r = await this.externalRecord(external);
      if (r.state !== "running") throw fail("runtime-unavailable", 503);
      const path = req.url.slice(req.url.indexOf("/http/") + 5);
      if (!path.startsWith("/") || path.startsWith("//") || /[\\\r\n]/.test(path) || /%(?:2f|5c|0[ad])/i.test(path.split("?")[0]))
        throw fail("invalid-request");
      return this.relay(req, res, r, path);
    }
    if (suffix) throw fail("not-found", 404);
    if (req.method === "POST" && ["start", "stop"].includes(action)) {
      const body = await jsonBody(req);
      if (Object.keys(body).length) throw fail("invalid-request");
      this.closeSockets(external.id);
      this.cookies.delete(external.id);
      if (action === "start") await this.externalRequest(external, "/policy", "PUT", this.contextPolicy);
      await this.externalRequest(external, `/${action}`, "POST", {});
    } else if (req.method !== "GET" || action) throw fail("invalid-request");
    try {
      return this.json(res, 200, { runtime: await this.externalRecord(external) });
    } catch {
      return this.json(res, 200, { runtime: { id: external.id, state: "error", location: "local", name: external.name, errorCode: "local_runtime_offline" } });
    }
  }
  async syncExternalPolicies() {
    if (this.externalPolicySync) return;
    this.externalPolicySync = true;
    try {
      await Promise.allSettled(this.config.externalRuntimes.map((external) => this.externalRequest(external, "/policy", "PUT", this.contextPolicy)));
    } finally {
      this.externalPolicySync = false;
    }
  }
  async close() {
    clearInterval(this.timer);
    clearInterval(this.contextTimer);
    for (const id of this.sockets.keys()) this.closeSockets(id);
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

function sameMounts(c, directory, expected) {
  const mounts = new Map(expected.map(([part, target]) => [target, directory + "/" + part]));
  return (
    c.Mounts?.length === mounts.size &&
    !c.Mounts.some((m) => m.Type !== "bind" || mounts.get(m.Destination) !== m.Source || (READONLY.has(m.Destination) && m.RW))
  );
}

function validPodImages(value) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(([part, id]) => ["net", "napcat", "wechat"].includes(part) && typeof id === "string" && IMAGE_ID.test(id))
  );
}

function withoutPlugins(body) {
  if (body.plugins !== undefined) throw fail("invalid-request");
  return body;
}

function normalizePlugins(value) {
  if (!Array.isArray(value) || value.length > OPTIONAL_PLUGINS.length * 2 || value.some((name) => typeof name !== "string" || !OPTIONAL_PLUGINS.includes(name)))
    throw fail("invalid-request");
  return OPTIONAL_PLUGINS.filter((name) => value.includes(name));
}

function samePlugins(value) {
  try {
    const normalized = normalizePlugins(value);
    return normalized.length === value.length && normalized.every((name, index) => name === value[index]);
  } catch {
    return false;
  }
}

const PROGRAM_STATES = ["RUNNING", "STARTING", "STOPPED", "STOPPING", "BACKOFF", "EXITED", "FATAL", "UNKNOWN"];
/** `koishi  RUNNING  pid 15, uptime 5 days, 7:50:47` and the other supervisorctl status lines. */
function parseSupervisor(output) {
  const programs = {};
  for (const line of String(output).split("\n")) {
    const m = /^(koishi|napcat)\s+([A-Z]+)\b(.*)$/.exec(line.trim());
    if (!m) continue;
    const program = { state: PROGRAM_STATES.includes(m[2]) ? m[2] : "UNKNOWN" };
    const pid = /\bpid\s+(\d+)/.exec(m[3]);
    if (pid) program.pid = Number(pid[1]);
    const up = /\buptime\s+(?:(\d+)\s+days?,\s+)?(\d+):(\d{2}):(\d{2})/.exec(m[3]);
    if (up) program.uptimeSeconds = Number(up[1] ?? 0) * 86400 + Number(up[2]) * 3600 + Number(up[3]) * 60 + Number(up[4]);
    programs[m[1]] = program;
  }
  return programs;
}
const SIZE_UNITS = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
function parseSize(text) {
  const m = /^\s*([\d.]+)\s*([a-zA-Z]+)\s*$/.exec(text ?? "");
  const unit = m && SIZE_UNITS[m[2].toLowerCase()];
  return unit ? Math.round(Number(m[1]) * unit) : undefined;
}
/** One `docker stats --no-stream --format '{{json .}}'` line: `MemUsage: "612.6MiB / 1GiB"`, `CPUPerc: "1.95%"`. */
function parseStats(output) {
  try {
    const row = JSON.parse(String(output).trim().split("\n")[0]);
    const [used, limit] = String(row.MemUsage).split("/").map(parseSize);
    const cpu = Number.parseFloat(row.CPUPerc);
    return {
      ...(used !== undefined && limit !== undefined ? { memory: { usedBytes: used, limitBytes: limit } } : {}),
      ...(Number.isFinite(cpu) ? { cpuPercent: cpu } : {}),
    };
  } catch {
    return undefined;
  }
}
function parseRelease(output) {
  try {
    const v = JSON.parse(String(output));
    if (!v || typeof v !== "object" || ![v.commit, v.deployId, v.deployedAt].every((x) => typeof x === "string" && x.length > 0 && x.length <= 200))
      return undefined;
    return { commit: v.commit, deployId: v.deployId, deployedAt: v.deployedAt };
  } catch {
    return undefined;
  }
}
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function runCommand(command, args) {
  return new Promise((resolve, reject) =>
    execFile(command, args, { timeout: 60000, maxBuffer: 1024 * 1024 }, (error, stdout) =>
      error ? reject(fail("runtime-operation-failed", 502)) : resolve(stdout),
    ),
  );
}

function origin(value) {
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol) || u.origin !== value || u.hostname.includes("*") || u.username || u.password) throw 0;
    return value;
  } catch {
    throw fail("invalid-config");
  }
}

function privatePath(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value === "/" ||
    value.includes("//") ||
    /[\n\r,:]/.test(value) ||
    value.split("/").some((x) => x === ".." || x === ".")
  )
    throw fail("invalid-config");
  let current = "";
  for (const part of value.split("/").filter(Boolean)) {
    current += "/" + part;
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw fail("unsafe-path");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return value.replace(/\/$/, "");
}

function secureDir(value) {
  privatePath(value);
  fs.mkdirSync(value, { recursive: true, mode: 0o700 });
  fs.chmodSync(value, 0o700);
}

function atomic(file, data) {
  privatePath(file);
  const temp = file + "." + randomBytes(8).toString("hex");
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

function readPrivate(file) {
  privatePath(file);
  const st = fs.statSync(file);
  if (!st.isFile() || st.mode & 0o077 || st.uid !== process.getuid?.()) throw fail("unsafe-private-file");
  return fs.readFileSync(file, "utf8");
}

function validateConfig(c) {
  if (
    !c ||
    typeof c !== "object" ||
    Object.keys(c).some(
      (k) =>
        ![
          "image",
          "rootDir",
          "tokenFile",
          "bindHost",
          "port",
          "caps",
          "publicOrigin",
          "additionalOrigins",
          "reservedOwnerQQ",
          "deviceGateway",
          "contextPolicyFile",
          "externalRuntimes",
          "hostGatewayPorts",
          "egress",
          "owner",
          "pod",
          "computer", // Read-only upgrade compatibility: ignored and omitted from the validated config.
        ].includes(k),
    ) ||
    typeof c.image !== "string" ||
    !IMAGE_REFERENCE.test(c.image)
  )
    throw fail("invalid-config");
  // The images an account runs as separate containers (leave-koishi 6.7): `docker build --target app` and
  // `--target wechat`, and the unmodified NapCat image.
  let pod;
  if (c.pod !== undefined) {
    if (
      !c.pod ||
      typeof c.pod !== "object" ||
      Array.isArray(c.pod) ||
      Object.keys(c.pod).length !== 3 ||
      ["app", "napcat", "wechat"].some((key) => typeof c.pod[key] !== "string" || !IMAGE_REFERENCE.test(c.pod[key]))
    )
      throw fail("invalid-config");
    pod = { app: c.pod.app, napcat: c.pod.napcat, wechat: c.pod.wechat };
  }
  // The owner's own container, operated through the same ops API. Never one the manager creates.
  let owner;
  if (c.owner !== undefined) {
    if (
      !c.owner ||
      typeof c.owner !== "object" ||
      Array.isArray(c.owner) ||
      Object.keys(c.owner).some((key) => key !== "container") ||
      typeof c.owner.container !== "string" ||
      !CONTAINER_NAME.test(c.owner.container) ||
      c.owner.container.startsWith("yesimbot-member-")
    )
      throw fail("invalid-config");
    owner = { container: c.owner.container };
  }
  const rootDir = privatePath(c.rootDir),
    tokenFile = privatePath(c.tokenFile);
  const bindHost = c.bindHost || "127.0.0.1";
  if (
    !net.isIPv4(bindHost) ||
    !(bindHost.startsWith("127.") || bindHost.startsWith("10.") || bindHost.startsWith("192.168.") || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(bindHost))
  )
    throw fail("invalid-config");
  const port = c.port ?? 15150;
  const egress = c.egress;
  if (
    egress !== undefined &&
    (!egress ||
      typeof egress !== "object" ||
      Object.keys(egress).some((k) => !["port", "directHosts"].includes(k)) ||
      !Number.isInteger(egress.port) ||
      egress.port < 1024 ||
      egress.port > 65535 ||
      typeof egress.directHosts !== "string" ||
      !/^[a-zA-Z0-9.,:-]*$/.test(egress.directHosts))
  )
    throw fail("invalid-config");
  const hostGatewayPorts = c.hostGatewayPorts ?? [];
  if (
    !Array.isArray(hostGatewayPorts) ||
    hostGatewayPorts.length > 8 ||
    new Set(hostGatewayPorts).size !== hostGatewayPorts.length ||
    hostGatewayPorts.some((value) => !Number.isInteger(value) || value < 1024 || value > 65535)
  )
    throw fail("invalid-config");
  if (c.caps && (typeof c.caps !== "object" || Array.isArray(c.caps) || Object.keys(c.caps).some((k) => !["cpus", "memoryMB", "pids", "shmMB"].includes(k))))
    throw fail("invalid-config");
  const caps = { cpus: 1, memoryMB: 1024, pids: 512, shmMB: 256, ...(c.caps || {}) };
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !Number.isFinite(caps.cpus) ||
    caps.cpus < 0.25 ||
    caps.cpus > 8 ||
    !Number.isInteger(caps.memoryMB) ||
    caps.memoryMB < 512 ||
    caps.memoryMB > 16384 ||
    !Number.isInteger(caps.pids) ||
    caps.pids < 64 ||
    caps.pids > 2048 ||
    !Number.isInteger(caps.shmMB) ||
    caps.shmMB < 64 ||
    caps.shmMB > 1024
  )
    throw fail("invalid-config");
  const publicOrigin = origin(c.publicOrigin);
  if (c.additionalOrigins !== undefined && !Array.isArray(c.additionalOrigins)) throw fail("invalid-config");
  const additionalOrigins = (c.additionalOrigins || []).map(origin);
  if (c.reservedOwnerQQ !== undefined && !QQ.test(c.reservedOwnerQQ)) throw fail("invalid-config");
  let deviceGateway;
  if (c.deviceGateway !== undefined) {
    const value = c.deviceGateway;
    if (!value || typeof value !== "object" || Object.keys(value).some((key) => !["origin", "cli", "stateDir", "localPort", "controlPort"].includes(key)))
      throw fail("invalid-config");
    const gatewayOrigin = origin(value.origin);
    if (!gatewayOrigin.startsWith("https://")) throw fail("invalid-config");
    // The gateway's own cleartext entry for containers on this host (its --local-port).
    if (value.localPort !== undefined && (!Number.isInteger(value.localPort) || value.localPort < 1024 || value.localPort > 65535))
      throw fail("invalid-config");
    // The gateway's loopback port, used to revoke devices only when an account is explicitly deleted.
    if (value.controlPort !== undefined && (!Number.isInteger(value.controlPort) || value.controlPort < 1024 || value.controlPort > 65535))
      throw fail("invalid-config");
    deviceGateway = {
      origin: gatewayOrigin,
      cli: privatePath(value.cli),
      stateDir: privatePath(value.stateDir),
      ...(value.localPort ? { localPort: value.localPort } : {}),
      ...(value.controlPort ? { controlPort: value.controlPort } : {}),
    };
  }
  const contextPolicyFile = c.contextPolicyFile === undefined ? undefined : privatePath(c.contextPolicyFile);
  const externalRuntimes = c.externalRuntimes ?? [];
  if (!Array.isArray(externalRuntimes) || externalRuntimes.length > 128 || new Set(externalRuntimes.map((r) => r?.id)).size !== externalRuntimes.length)
    throw fail("invalid-config");
  for (const r of externalRuntimes) {
    if (
      !r ||
      Object.keys(r).some((key) => !["id", "name", "controlPort", "backendPort", "tokenFile", "passwordFile"].includes(key)) ||
      !UUID.test(r.id) ||
      typeof r.name !== "string" ||
      r.name.length > 128 ||
      ![r.controlPort, r.backendPort].every((port) => Number.isInteger(port) && port >= 1024 && port <= 65535) ||
      r.controlPort === r.backendPort
    )
      throw fail("invalid-config");
    privatePath(r.tokenFile);
    privatePath(r.passwordFile);
  }
  return {
    ...(owner ? { owner } : {}),
    ...(pod ? { pod } : {}),
    externalRuntimes,
    deviceGateway,
    contextPolicyFile,
    hostGatewayPorts,
    egress,
    rootDir,
    tokenFile,
    bindHost,
    port,
    caps,
    image: c.image,
    publicOrigin,
    additionalOrigins,
    reservedOwnerQQ: c.reservedOwnerQQ,
  };
}

function chatIdentityHeaders(source, path, cookie) {
  const name = source["x-yesimbot-chat-name"];
  if (path.split("?", 1)[0] !== "/yesimbot/api/v1/chat/send" || typeof name !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(name)) return {};
  return { "x-yesimbot-chat-name": name, "x-yesimbot-chat-proof": createHmac("sha256", cookie).update(`web-chat:${name}`).digest("hex") };
}

function desktopIdentityHeaders(source, path, cookie) {
  const login = source["x-yesimbot-control-login"];
  if (
    !["/yesimbot/api/v1/devices/control", "/yesimbot/api/v1/devices/desktop"].includes(path.split("?", 1)[0]) ||
    typeof login !== "string" ||
    !/^[a-f0-9]{64}$/.test(login)
  )
    return {};
  return { "x-yesimbot-control-login": login, "x-yesimbot-control-proof": createHmac("sha256", cookie).update(`desktop-login:${login}`).digest("hex") };
}

function headers(source, websocket = false) {
  const blocked = new Set([
    "authorization",
    "cookie",
    "host",
    "set-cookie",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "forwarded",
    "origin",
  ]);
  for (const key of String(source.connection || "").split(",")) blocked.add(key.trim().toLowerCase());
  const result = {};
  for (const [key, value] of Object.entries(source))
    if (!blocked.has(key.toLowerCase()) && !key.toLowerCase().startsWith("x-") && (!key.toLowerCase().startsWith("sec-websocket-") || websocket))
      result[key] = value;
  if (websocket) {
    result.connection = "Upgrade";
    result.upgrade = "websocket";
  }
  return result;
}

async function jsonBody(req, keys = ["qqAccount", "plugins"]) {
  let result = "";
  for await (const part of req) {
    result += part;
    if (Buffer.byteLength(result) > 8192) throw fail("invalid-request", 413);
  }
  try {
    const value = JSON.parse(result || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !keys.includes(k))) throw 0;
    return value;
  } catch {
    throw fail("invalid-request");
  }
}

export { OPTIONAL_PLUGINS, RuntimeManager, runCommand, validateConfig, validateContextPolicy, chatIdentityHeaders, desktopIdentityHeaders };

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  try {
    if (process.getuid?.() !== 0 || process.argv.length !== 3) throw fail("root-config-required");
    const manager = new RuntimeManager(JSON.parse(readPrivate(process.argv[2])));
    await manager.listen();
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => manager.close().then(() => process.exit(0)));
  } catch {
    process.stderr.write("Runtime manager failed to initialize.\n");
    process.exitCode = 1;
  }
}
