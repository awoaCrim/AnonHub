import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { readFile, writeFile, rename, mkdir, open, lstat } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
async function privateJson(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65536 || (process.platform !== "win32" && info.mode & 0o077))
    throw new Error("unsafe_host_config");
  return JSON.parse(await readFile(file, "utf8"));
}
async function atomic(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + randomBytes(8).toString("hex") + ".tmp";
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Loopback-only supervisor. The administrator connects through an authenticated private tunnel. */
export class LocalRuntimeHost {
  constructor(config) {
    if (
      !config ||
      config.version !== 1 ||
      !UUID.test(config.id) ||
      !/^[a-f0-9]{64}$/.test(config.token) ||
      ![config.node, config.entry, config.appRoot, config.stateRoot].every((path) => typeof path === "string" && isAbsolute(path)) ||
      ![config.port, config.backendPort].every((port) => Number.isInteger(port) && port >= 1024 && port <= 65535) ||
      config.port === config.backendPort
    )
      throw new Error("invalid_local_host_config");
    this.config = config;
    this.state = "stopped";
    this.desired = false;
    this.retries = 0;
    this.updatedAt = new Date().toISOString();
    this.queue = Promise.resolve();
    if (config.tunnel) {
      const t = config.tunnel;
      if (
        ![t.executable, t.keyFile, t.knownHostsFile].every((p) => typeof p === "string" && isAbsolute(p)) ||
        !/^[a-zA-Z0-9.-]+$/.test(t.host) ||
        !/^[a-zA-Z0-9_-]+$/.test(t.user) ||
        ![t.port, t.backendPort, t.controlPort].every((p) => Number.isInteger(p) && p > 0 && p <= 65535) ||
        t.backendPort === t.controlPort
      )
        throw new Error("invalid_local_tunnel_config");
      if (
        t.forwards !== undefined &&
        (!Array.isArray(t.forwards) ||
          t.forwards.length > 8 ||
          t.forwards.some(
            (f) =>
              !f ||
              ![f.localPort, f.port].every((p) => Number.isInteger(p) && p >= 1024 && p <= 65535) ||
              !/^(?:127\.0\.0\.1|172\.(?:1[6-9]|2[0-9]|3[01])\.0\.1)$/.test(f.host),
          ) ||
          new Set(t.forwards.map((f) => f.localPort)).size !== t.forwards.length)
      )
        throw new Error("invalid_local_tunnel_forward");
    }
    if (
      config.browser &&
      (!isAbsolute(config.browser.executable ?? "") ||
        !isAbsolute(config.browser.profileDirectory ?? "") ||
        !Number.isInteger(config.browser.port) ||
        config.browser.port < 1024 ||
        config.browser.port > 65535 ||
        [config.port, config.backendPort].includes(config.browser.port))
    )
      throw new Error("invalid_local_browser_config");
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => this.json(res, 503, { message: "local_runtime_unavailable" }));
    });
    this.server.headersTimeout = 10000;
    this.server.requestTimeout = 30000;
  }
  json(res, status, value) {
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  }
  authorized(req) {
    const expected = Buffer.from("Bearer " + this.config.token),
      actual = Buffer.from(String(req.headers.authorization ?? ""));
    return !req.headers.origin && !req.headers["x-forwarded-for"] && actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  view() {
    return {
      id: this.config.id,
      state: this.state,
      location: "local",
      platform: process.platform,
      name: this.config.name ?? "本机",
      version: this.config.release ?? "development",
      updatedAt: this.updatedAt,
      policyVersion: this.policyVersion ?? null,
      errorCode: this.state === "error" ? "local_runtime_failed" : undefined,
    };
  }
  async body(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) throw new Error("body_too_large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }
  async handle(req, res) {
    if (!this.authorized(req)) return this.json(res, 401, { message: "unauthorized" });
    if (req.method === "GET" && req.url === "/health") return this.json(res, 200, { ok: true, runtime: this.view() });
    if (req.method === "GET" && req.url === "/runtime") return this.json(res, 200, { runtime: this.view() });
    if (req.method === "POST" && ["/start", "/stop"].includes(req.url)) {
      const body = await this.body(req);
      if (Object.keys(body).length) return this.json(res, 400, { message: "invalid_request" });
      await this.setDesired(req.url === "/start");
      return this.json(res, 200, { runtime: this.view() });
    }
    if (req.method === "PUT" && req.url === "/policy") {
      const body = await this.body(req);
      await this.applyPolicy(body);
      return this.json(res, 200, { policyVersion: this.policyVersion });
    }
    return this.json(res, 404, { message: "not_found" });
  }
  async applyPolicy(body) {
    const definition = JSON.parse(await readFile(join(dirname(this.config.entry), "context-policy.json"), "utf8"));
    const validate = (shape, value) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => Object.hasOwn(shape, key)) &&
      Object.entries(shape).every(([key, rule]) => {
        if (!Array.isArray(rule)) return validate(rule, value[key]);
        const item = value[key];
        if (item === undefined) return rule[1] === null;
        return typeof item === "number" && Number.isFinite(item) && item >= rule[2] && (rule[0] !== "integer" || Number.isSafeInteger(item));
      });
    if (!body || body.version !== 1 || !validate(definition, body.session) || Object.keys(body).some((key) => !["version", "session"].includes(key)))
      throw new Error("invalid_context_policy");
    const nextVersion = digest(body);
    if (this.policyVersion !== nextVersion) await atomic(join(this.config.stateRoot, "policy", "context.json"), body);
    this.policyVersion = nextVersion;
  }
  async setDesired(value) {
    this.desired = value;
    this.retries = 0;
    await atomic(join(this.config.stateRoot, "desired.json"), { version: 1, running: value });
    this.state = value ? (this.child ? this.state : "starting") : "stopping";
    this.queue = this.queue
      .catch(() => {})
      .then(() => (value ? this.start() : this.stop()))
      .catch(() => {
        this.state = "error";
      });
  }
  async start() {
    if (this.child || !this.desired || this.closing) return;
    const policy = await privateJson(join(this.config.stateRoot, "policy", "context.json"));
    await this.applyPolicy(policy);
    const identity = await privateJson(join(this.config.appRoot, "data", "yesimbot", "runtime-identity.json"));
    if (identity.tenantId !== this.config.id) throw new Error("local_host_identity_mismatch");
    await this.ensureBrowser();
    this.state = "starting";
    this.updatedAt = new Date().toISOString();
    const logDir = join(this.config.stateRoot, "logs");
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    const log = await open(join(logDir, `bot-${Date.now()}.log`), "ax", 0o600);
    const child = spawn(this.config.node, [this.config.entry], {
      cwd: this.config.appRoot,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", log.fd, log.fd, "ipc"],
      env: {
        ...process.env,
        YESIMBOT_MANAGED_CONTEXT: "1",
        YESIMBOT_CONTEXT_POLICY_FILE: join(this.config.stateRoot, "policy", "context.json"),
        YESIMBOT_LOCAL_INSTANCE_ID: this.config.id,
        YESIMBOT_LOCAL_RELEASE: this.config.release ?? "development",
        NODE_TLS_REJECT_UNAUTHORIZED: "1",
        NODE_PATH: [join(dirname(this.config.entry), "docker", "app", "node_modules"), join(dirname(this.config.entry), "node_modules")].join(
          process.platform === "win32" ? ";" : ":",
        ),
      },
    });
    this.child = child;
    let exited = false;
    const onExit = () => {
      if (exited) return;
      exited = true;
      void log.close();
      if (this.child === child) this.child = undefined;
      if (this.closing || !this.desired) {
        this.state = "stopped";
        return;
      }
      this.state = "error";
      this.updatedAt = new Date().toISOString();
      if (++this.retries <= 3) {
        this.retry = setTimeout(
          () => {
            this.queue = this.queue
              .catch(() => {})
              .then(() => this.start())
              .catch(() => {
                this.state = "error";
              });
          },
          Math.min(1000 * 2 ** this.retries, 15000),
        );
      }
    };
    child.once("exit", onExit);
    child.once("error", onExit);
    for (let i = 0; i < 60 && this.child === child && this.desired; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.config.backendPort}/yesimbot/local/health`, {
          signal: AbortSignal.timeout(1000),
          redirect: "error",
        });
        if (response.ok) {
          const body = await response.json();
          if (body.ready === true && body.instanceId === this.config.id) {
            this.state = "running";
            this.updatedAt = new Date().toISOString();
            return;
          }
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (this.child === child && this.state !== "running") {
      this.state = "error";
      await this.terminate(child);
    }
  }
  async terminate(child) {
    if (!child.pid || child.exitCode !== null) return;
    // The host stops on SIGTERM, or on Windows on the IPC exit message; process trees there need taskkill when that fails.
    child.send?.({ type: "exit" }, () => {});
    const exited = new Promise((resolve) => child.once("exit", resolve));
    if (process.platform !== "win32") child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (child.exitCode !== null) return;
    if (process.platform === "win32")
      await new Promise((resolve) => {
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        killer.once("exit", resolve);
        killer.once("error", resolve);
      });
    else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  async stop() {
    clearTimeout(this.retry);
    this.state = "stopping";
    if (this.child) await this.terminate(this.child);
    this.state = "stopped";
    this.updatedAt = new Date().toISOString();
  }
  async listen() {
    await mkdir(this.config.stateRoot, { recursive: true, mode: 0o700 });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, "127.0.0.1", resolve);
    });
    this.connectTunnel();
    try {
      this.desired = (await privateJson(join(this.config.stateRoot, "desired.json"))).running === true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (this.desired)
      this.queue = this.start().catch(() => {
        this.state = "error";
      });
  }
  connectTunnel() {
    if (!this.config.tunnel || this.closing || this.tunnel) return;
    const t = this.config.tunnel;
    const forwards = (t.forwards ?? []).flatMap((f) => ["-L", `127.0.0.1:${f.localPort}:${f.host}:${f.port}`]);
    const child = spawn(
      t.executable,
      [
        "-N",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "UserKnownHostsFile=" + t.knownHostsFile,
        "-i",
        t.keyFile,
        "-p",
        String(t.port),
        "-R",
        `127.0.0.1:${t.backendPort}:127.0.0.1:${this.config.backendPort}`,
        "-R",
        `127.0.0.1:${t.controlPort}:127.0.0.1:${this.config.port}`,
        ...forwards,
        `${t.user}@${t.host}`,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    this.tunnel = child;
    let finished = false;
    const reconnect = () => {
      if (finished) return;
      finished = true;
      if (this.tunnel === child) this.tunnel = undefined;
      if (!this.closing) this.tunnelRetry = setTimeout(() => this.connectTunnel(), 5000);
    };
    child.once("exit", reconnect);
    child.once("error", reconnect);
  }
  async ensureBrowser() {
    const b = this.config.browser;
    if (!b) return;
    try {
      if ((await fetch(`http://127.0.0.1:${b.port}/json/version`, { signal: AbortSignal.timeout(1000), redirect: "error" })).ok) return;
    } catch {}
    await mkdir(b.profileDirectory, { recursive: true, mode: 0o700 });
    // A dedicated, persistent interactive profile. Pausing the bot leaves its open browser tabs intact.
    const browser = spawn(
      b.executable,
      [
        `--user-data-dir=${b.profileDirectory}`,
        `--remote-debugging-port=${b.port}`,
        "--remote-debugging-address=127.0.0.1",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { detached: true, stdio: "ignore" },
    );
    browser.on("error", () => {});
    browser.unref();
  }
  async close() {
    this.closing = true;
    clearTimeout(this.retry);
    clearTimeout(this.tunnelRetry);
    this.tunnel?.kill();
    await this.queue.catch(() => {});
    await this.stop();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const host = new LocalRuntimeHost(await privateJson(resolve(process.argv[2])));
  await host.listen();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void host.close().then(() => process.exit(0));
    });
}
