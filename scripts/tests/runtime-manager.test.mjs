import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { OPTIONAL_PLUGINS, RuntimeManager, validateConfig, validateContextPolicy, chatIdentityHeaders, desktopIdentityHeaders } from "../runtime-manager.mjs";
const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222";
const image = "sha256:" + "a".repeat(64),
  token = "b".repeat(64);

test("chat display identity is bound to the private child cookie and only to the chat ingress", () => {
  const name = Buffer.from("alice").toString("base64url");
  const cookie = "yesimbot_admin=child-secret";
  const identity = chatIdentityHeaders({ "x-yesimbot-chat-name": name, "x-yesimbot-chat-proof": "forged" }, "/yesimbot/api/v1/chat/send", cookie);
  assert.deepEqual(identity, { "x-yesimbot-chat-name": name, "x-yesimbot-chat-proof": createHmac("sha256", cookie).update(`web-chat:${name}`).digest("hex") });
  assert.notEqual(
    chatIdentityHeaders({ "x-yesimbot-chat-name": name }, "/yesimbot/api/v1/chat/send", "other-child")["x-yesimbot-chat-proof"],
    identity["x-yesimbot-chat-proof"],
  );
  assert.deepEqual(chatIdentityHeaders({ "x-yesimbot-chat-name": name }, "/yesimbot/admin/accounts", cookie), {});
  assert.deepEqual(chatIdentityHeaders({ "x-yesimbot-chat-name": "bad value" }, "/yesimbot/api/v1/chat/send", cookie), {});
});

test("root-selected host services allow only the member bridge gateway and TCP port", async (t) => {
  const calls = [];
  const { manager, config } = fixture(t, async (command, args) => {
    calls.push([command, ...args]);
    if (args.includes("-C")) throw Error("absent");
    return "";
  });
  manager.config = validateConfig({ ...config, hostGatewayPorts: [18334] });
  await manager.firewall("yb111111111111", "172.30.0.1");
  const inserts = calls.filter((call) => call.includes("-I"));
  const accept = inserts.find((call) => call.includes("ACCEPT"));
  assert.deepEqual(accept, [
    "iptables",
    "-w",
    "-I",
    "INPUT",
    "1",
    "-i",
    "yb111111111111",
    "-d",
    "172.30.0.1",
    "-p",
    "tcp",
    "--dport",
    "18334",
    "-m",
    "conntrack",
    "--ctstate",
    "NEW",
    "-j",
    "ACCEPT",
  ]);
  assert.ok(inserts.findIndex((call) => call.includes("REJECT")) < inserts.indexOf(accept));
  assert.ok(inserts.some((call) => call.includes("DOCKER-USER") && call.includes("REJECT")));
});

test("host service access defaults closed and invalid ports or gateway never create an exception", async (t) => {
  const calls = [];
  const { manager, config } = fixture(t, async (command, args) => {
    calls.push([command, ...args]);
    if (args.includes("-C")) throw Error("absent");
    return "";
  });
  await manager.firewall("yb111111111111");
  assert.ok(!calls.some((call) => call.includes("ACCEPT")));
  for (const ports of ["18334", [0], [80], [65536], [18334, 18334], [18334.5], [true], Array.from({ length: 9 }, (_, index) => 18000 + index)])
    assert.throws(() => validateConfig({ ...config, hostGatewayPorts: ports }));
  manager.config = validateConfig({ ...config, hostGatewayPorts: [18334] });
  calls.length = 0;
  await assert.rejects(manager.firewall("yb111111111111"), /unsafe-network/);
  assert.equal(calls.length, 0);
});

test("owner context policy reaches existing and future members and invalid updates retain last valid settings", async (t) => {
  const { manager, root, config } = fixture(t);
  const shape = JSON.parse(fs.readFileSync(new URL("../../plugins/console/src/shared/context-policy.json", import.meta.url), "utf8"));
  const defaults = (object) =>
    Object.fromEntries(
      Object.entries(object).flatMap(([key, rule]) => (Array.isArray(rule) ? (rule[1] === null ? [] : [[key, rule[1]]]) : [[key, defaults(rule)]])),
    );
  const policy = { version: 1, session: defaults(shape) };
  assert.equal(validateContextPolicy(policy), policy);
  const source = root + "/owner-policy.json";
  fs.writeFileSync(source, JSON.stringify(policy), { mode: 0o600 });
  manager.config.contextPolicyFile = source;
  manager.register(A, {});
  fs.mkdirSync(config.rootDir + "/" + A, { recursive: true });
  manager.syncContextPolicy();
  assert.deepEqual(JSON.parse(fs.readFileSync(config.rootDir + "/" + A + "/policy/context.json")), policy);
  policy.session.magicContext.triggerTokens = 64000;
  fs.writeFileSync(source, JSON.stringify(policy));
  manager.syncContextPolicy();
  manager.register(B, {});
  manager.writePolicy(manager.get(B));
  for (const id of [A, B]) assert.deepEqual(JSON.parse(fs.readFileSync(config.rootDir + "/" + id + "/policy/context.json")), policy);
  fs.writeFileSync(source, JSON.stringify({ ...policy, session: { ...policy.session, apiKey: "forbidden" } }));
  manager.syncContextPolicy();
  assert.deepEqual(manager.contextPolicy, policy);
  const resumed = new RuntimeManager({ ...config, contextPolicyFile: source });
  assert.deepEqual(resumed.contextPolicy, policy);
  // Keys Core no longer reads are not tolerated: the policy is refused as a whole.
  const old = structuredClone(policy);
  old.session.magicContext.contextWindow = 147200;
  assert.throws(() => validateContextPolicy(old));
  assert.throws(() => validateContextPolicy({ ...policy, session: { ...policy.session, compact: { mode: "compartment" } } }));
  assert.throws(() => validateContextPolicy({ ...policy, session: { ...policy.session, magicContext: { ...policy.session.magicContext, enabled: true } } }));
  assert.throws(() => validateContextPolicy({ ...policy, session: { ...policy.session, magicContext: { ...policy.session.magicContext, model: "" } } }));
});
test("the owner's Google app reaches every friend, and a bad one never replaces a good one", async (t) => {
  const { manager, root, config } = fixture(t);
  const dir = root + "/owner-admin";
  fs.mkdirSync(dir, { mode: 0o700 });
  manager.config.contextPolicyFile = dir + "/context-policy.json";
  const source = dir + "/google-app.json";
  const read = (id) => JSON.parse(fs.readFileSync(config.rootDir + "/" + id + "/policy/google.json"));
  manager.register(A, {});
  fs.mkdirSync(config.rootDir + "/" + A, { recursive: true });
  manager.syncGoogleApp();
  // Never published: not set up.
  assert.deepEqual(read(A), { version: 1 });
  const app = {
    version: 1,
    clientId: "123-abc.apps.googleusercontent.com",
    clientSecret: "GOCSPX-x",
    redirectUri: "https://bot.example/yesimbot/api/v1/connectors/google/callback",
  };
  fs.writeFileSync(source, JSON.stringify(app), { mode: 0o600 });
  manager.syncGoogleApp();
  manager.register(B, {});
  manager.writePolicy(manager.get(B));
  for (const id of [A, B]) assert.deepEqual(read(id), app);
  for (const bad of [
    { ...app, redirectUri: "http://bot.example/yesimbot/api/v1/connectors/google/callback" },
    { ...app, clientId: "x" },
    { ...app, extra: 1 },
  ]) {
    fs.writeFileSync(source, JSON.stringify(bad));
    manager.syncGoogleApp();
    assert.deepEqual(read(A), app);
  }
  // Readable by others: refused, the last good one stays.
  fs.writeFileSync(source, JSON.stringify({ version: 1 }));
  fs.chmodSync(source, 0o644);
  manager.syncGoogleApp();
  assert.deepEqual(read(A), app);
  fs.chmodSync(source, 0o600);
  manager.syncGoogleApp();
  assert.deepEqual(read(A), { version: 1 });
  fs.writeFileSync(source, JSON.stringify(app));
  manager.syncGoogleApp();
  assert.deepEqual(new RuntimeManager({ ...config }).googleApp, app);
});
function fixture(t, run = async () => "") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yb-manager-")));
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(root + "/token", token, { mode: 0o600 });
  const config = {
    rootDir: root + "/members",
    tokenFile: root + "/token",
    image: "yesimbot:tested",
    publicOrigin: "https://bot.example",
    reservedOwnerQQ: "123456789",
  };
  const manager = new RuntimeManager(config, { run, readinessAttempts: 1, retryDelay: 0 });
  t.after(async () => {
    if (manager.server.listening) await manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { manager, root, config };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function api(manager, target, method = "GET", body, auth = token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: manager.server.address().port,
        path: target,
        method,
        headers: { authorization: "Bearer " + auth, "content-type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (x) => (data += x));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(data) }));
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function dockerMock() {
  const calls = [],
    containers = new Map(),
    networks = new Map();
  let port = 22000;
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "iptables") {
      if (args.includes("-C")) throw Error("absent");
      return "";
    }
    if (args[0] === "image") return JSON.stringify([{ Id: image }]);
    if (args[0] === "network" && args[1] === "ls") return [...networks.keys()].join("\n");
    if (args[0] === "network" && args[1] === "create") {
      const name = args.at(-1);
      networks.set(name, {
        Labels: { "io.yesimbot.runtime": name.slice("yesimbot-member-".length) },
        Driver: "bridge",
        EnableIPv6: false,
        Options: { "com.docker.network.bridge.enable_icc": "false", "com.docker.network.bridge.name": args[args.indexOf("--opt") + 1].split("=")[1] },
        IPAM: { Config: [{ Subnet: `172.${30 + networks.size}.0.0/16`, Gateway: `172.${30 + networks.size}.0.1` }] },
      });
      return "";
    }
    if (args[0] === "network" && args[1] === "inspect") return JSON.stringify([networks.get(args[2])]);
    if (args[0] === "ps") return [...containers.keys()].join("\n");
    if (args[0] === "inspect") return JSON.stringify([containers.get(args[1])]);
    if (args[0] === "create") {
      const name = args[args.indexOf("--name") + 1],
        network = args[args.indexOf("--network") + 1];
      const mounts = args
        .flatMap((x, i) => (x === "--mount" ? [args[i + 1]] : []))
        .map((x) => {
          const p = Object.fromEntries(x.split(",").map((y) => y.split("=")));
          return { Type: p.type, Source: p.src, Destination: p.dst, RW: !x.endsWith(",readonly") };
        });
      containers.set(name, {
        Image: args.at(-1),
        Config: { Labels: { "io.yesimbot.runtime": name.slice("yesimbot-member-".length) }, Env: args.flatMap((x, i) => (x === "--env" ? [args[i + 1]] : [])) },
        HostConfig: {
          CapDrop: ["ALL"],
          CapAdd: ["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_KILL", "CAP_SETGID", "CAP_SETUID"],
          SecurityOpt: ["no-new-privileges:true"],
          Sysctls: { "net.ipv6.conf.all.disable_ipv6": "1" },
          NanoCpus: 1e9,
          Memory: 1024 * 1024 * 1024,
          MemorySwap: 1024 * 1024 * 1024,
          PidsLimit: 512,
          ShmSize: 256 * 1024 * 1024,
          LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "2" } },
          NetworkMode: network,
          RestartPolicy: { Name: "no" },
          PortBindings: { "5140/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
        },
        Mounts: mounts,
        State: { Running: false },
        NetworkSettings: { Networks: { [network]: {} }, Ports: { "5140/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port++) }] } },
      });
      return "";
    }
    if (args[0] === "rm") {
      containers.delete(args.at(-1));
      return "";
    }
    if (args[0] === "start" || args[0] === "stop") {
      containers.get(args.at(-1)).State.Running = args[0] === "start";
      return "";
    }
    throw Error("unexpected command");
  };
  return { run, calls, containers, networks };
}
test("root config rejects arbitrary path, address, image and resource settings", (t) => {
  const { config, root } = fixture(t);
  for (const change of [
    { rootDir: "/tmp/../x" },
    { rootDir: "//" },
    { rootDir: "/tmp//members" },
    { publicOrigin: "https://*.example" },
    { image: "--privileged" },
    { image: "a;id" },
    { bindHost: "0.0.0.0" },
    { caps: { pids: 0 } },
    { caps: { memoryMB: 1e9 } },
    { publicOrigin: "https://user:pw@bot.example" },
    { additionalOrigins: ["https://bot.example/path"] },
  ])
    assert.throws(() => validateConfig({ ...config, ...change }));
  fs.symlinkSync(root, root + "/link");
  assert.throws(() => validateConfig({ ...config, rootDir: root + "/link/child" }));
});
test("provisions separate device credentials into read-only runtime policy mounts without QQ", async (t) => {
  const mock = dockerMock();
  const calls = [];
  const run = async (command, args) => {
    if (args.includes("ensure-runtime")) {
      const tenant = args[args.indexOf("--tenant") + 1],
        output = args[args.indexOf("--output") + 1];
      calls.push(tenant);
      fs.writeFileSync(output, JSON.stringify({ version: 1, tenantId: tenant, token: (tenant === A ? "a" : "b").repeat(64) }), { mode: 0o600 });
      return "";
    }
    return mock.run(command, args);
  };
  const { manager, root } = fixture(t, run);
  manager.config.deviceGateway = { origin: "https://devices.example", cli: root + "/gateway.cjs", stateDir: root + "/gateway" };
  manager.cookie = async () => "private-cookie";
  for (const id of [A, B]) {
    manager.register(id, {});
    manager.start(id, {});
  }
  await manager.drain();
  assert.deepEqual(calls.sort(), [A, B]);
  for (const id of [A, B]) {
    const container = mock.containers.get(manager.names(id).container);
    assert.equal(manager.records.get(id).state, "running");
    assert.ok(container.Config.Env.includes("QQ_ACCOUNT="));
    assert.ok(container.Config.Env.includes("YESIMBOT_DEVICE_GATEWAY=https://devices.example"));
    assert.ok(container.Mounts.some((mount) => mount.Source === root + "/members/" + id + "/policy" && !mount.RW));
    assert.equal(JSON.parse(fs.readFileSync(root + "/members/" + id + "/policy/device-credential.json")).tenantId, id);
  }
});
test("the device gateway's local entry is each member's own bridge address, opened only there", async (t) => {
  const mock = dockerMock();
  const firewall = [];
  const run = async (command, args) => {
    if (command === "iptables") {
      firewall.push(args);
      if (args.includes("-C")) throw Error("absent");
      return "";
    }
    if (args.includes("ensure-runtime")) {
      const tenant = args[args.indexOf("--tenant") + 1],
        output = args[args.indexOf("--output") + 1];
      fs.writeFileSync(output, JSON.stringify({ version: 1, tenantId: tenant, token: "a".repeat(64) }), { mode: 0o600 });
      return "";
    }
    return mock.run(command, args);
  };
  const { manager, root, config } = fixture(t, run);
  for (const localPort of [0, 80, 65536, 17401.5, "17401"])
    assert.throws(() =>
      validateConfig({ ...config, deviceGateway: { origin: "https://devices.example", cli: root + "/gateway.cjs", stateDir: root + "/gateway", localPort } }),
    );
  manager.config = validateConfig({ ...config, hostGatewayPorts: [18334] });
  // Containers created before the local entry existed carry only the public origin.
  manager.config.deviceGateway = { origin: "https://devices.example", cli: root + "/gateway.cjs", stateDir: root + "/gateway" };
  manager.cookie = async () => "private-cookie";
  manager.register(A, {});
  manager.start(A, {});
  await manager.drain();
  const name = manager.names(A).container;
  const first = mock.containers.get(name);
  assert.ok(!first.Config.Env.some((value) => value.startsWith("YESIMBOT_DEVICE_LOCAL_GATEWAY=")));
  // With the local entry configured, the manager's next start (a release) recreates it with its own bridge gateway.
  manager.config.deviceGateway = { ...manager.config.deviceGateway, localPort: 17401 };
  firewall.length = 0;
  await manager.reconcile();
  await manager.drain();
  const container = mock.containers.get(name);
  const hostGateway = mock.networks.get(manager.names(A).network).IPAM.Config[0].Gateway;
  assert.notEqual(container, first);
  assert.ok(container.Config.Env.includes("YESIMBOT_DEVICE_LOCAL_GATEWAY=http://" + hostGateway + ":17401"));
  assert.ok(container.Config.Env.includes("YESIMBOT_DEVICE_GATEWAY=https://devices.example"));
  const accepts = firewall.filter((args) => args.includes("-I") && args.includes("ACCEPT"));
  assert.deepEqual(accepts.map((args) => [args[args.indexOf("-d") + 1], args[args.indexOf("--dport") + 1]]).sort(), [
    [hostGateway, "17401"],
    [hostGateway, "18334"],
  ]);
});
test("unauthorized API has no Docker, state or directory side effects; UUID and body allowlist fail closed", async (t) => {
  const calls = [];
  const { manager, root } = fixture(t, async (...x) => calls.push(x));
  await listen(manager.server);
  assert.equal((await api(manager, "/v1/runtimes/" + A, "PUT", {}, "wrong")).status, 401);
  assert.equal(manager.records.size, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(fs.readdirSync(root + "/members"), []);
  assert.equal((await api(manager, "/v1/runtimes/owner", "PUT", {})).status, 404);
  assert.equal((await api(manager, "/v1/runtimes/" + A, "PUT", { image: "evil" })).status, 400);
  assert.equal((await api(manager, "/health")).status, 200);
});
test("lazy QQ assignment is unique and immutable; fresh paths/passwords, ports and networks are independent", async (t) => {
  const mock = dockerMock(),
    { manager, root } = fixture(t, mock.run);
  manager.cookie = async () => "private-cookie";
  const a = manager.register(A, {});
  assert.equal(a.state, "stopped");
  manager.start(A, {});
  await manager.drain();
  assert.equal(a.state, "running");
  assert.ok(mock.containers.get(manager.names(A).container).Config.Env.includes("QQ_ACCOUNT="));
  assert.throws(() => manager.start(A, { qqAccount: "123456789" }), /qq-account-in-use/);
  manager.start(A, { qqAccount: "11111" });
  const b = manager.register(B, { qqAccount: "22222" });
  manager.start(B, {});
  await manager.drain();
  assert.equal(a.state, "running");
  assert.equal(b.state, "running");
  assert.notEqual(a.port, b.port);
  assert.throws(() => manager.register(B, { qqAccount: "11111" }), /qq-account-in-use/);
  assert.throws(() => manager.register(A, { qqAccount: "33333" }), /qq-account-immutable/);
  const passwords = [A, B].map((id) => fs.readFileSync(root + "/members/" + id + "/backend-password", "utf8"));
  assert.notEqual(...passwords);
  for (const id of [A, B])
    for (const dir of ["qq", "koishi", "napcat-config", "napcat-plugins"]) assert.deepEqual(fs.readdirSync(root + "/members/" + id + "/" + dir), []);
  assert.equal(fs.statSync(root + "/members/runtimes.json").mode & 0o777, 0o600);
  const creates = mock.calls.filter((x) => x[1] === "create");
  assert.equal(creates.length, 3);
  for (const args of creates) {
    assert.ok(args.includes("no-new-privileges:true"));
    assert.ok(args.includes("ALL"));
    assert.ok(args.includes("127.0.0.1::5140"));
    assert.ok(!args.some((x) => x.includes("docker.sock") || x.includes("6099")));
  }
  for (const id of [A, B]) {
    const bridge = manager.names(id).bridge;
    const startAt = mock.calls.findIndex((x) => x[1] === "start" && x[2] === manager.names(id).container);
    const ruleAt = mock.calls.findIndex((x) => x[0] === "iptables" && x.includes(bridge) && x.includes("-I"));
    assert.ok(ruleAt >= 0 && ruleAt < startAt);
  }
  manager.start(A, {});
  manager.stop(A);
  manager.stop(A);
  await manager.drain();
  assert.equal(a.state, "stopped");
  assert.ok(fs.existsSync(root + "/members/" + A + "/backend-password"));
});
test("foreign labels, symlink directories, missing images and firewall failures never start a container", async (t) => {
  for (const mode of ["foreign", "symlink", "image", "firewall"]) {
    const mock = dockerMock(),
      { manager, root } = fixture(t, async (cmd, args) => {
        if (mode === "image" && args[0] === "image") throw Error("SECRET stderr");
        if (mode === "firewall" && cmd === "iptables") throw Error("SECRET stderr");
        return mock.run(cmd, args);
      });
    manager.cookie = async () => "cookie";
    manager.register(A, { qqAccount: "11111" });
    if (mode === "foreign") mock.containers.set(manager.names(A).container, { Config: { Labels: {} } });
    if (mode === "symlink") fs.symlinkSync(root, root + "/members/" + A);
    manager.start(A, {});
    await manager.drain();
    assert.equal(manager.get(A).state, "error");
    assert.equal(manager.view(manager.get(A)).errorCode, "runtime-operation-failed");
    assert.ok(!mock.calls.some((x) => x[1] === "start"));
  }
});
test("persisted desired lifecycle reconciles after manager restart and crash retry is bounded", async (t) => {
  const mock = dockerMock(),
    { manager, config } = fixture(t, mock.run);
  manager.cookie = async () => "cookie";
  manager.register(A, { qqAccount: "11111" });
  manager.start(A, {});
  await manager.drain();
  const second = new RuntimeManager(config, { run: mock.run, readinessAttempts: 1, retryDelay: 0 });
  second.cookie = async () => "cookie";
  const beforeRecovery = mock.calls.length;
  await second.reconcile();
  await second.drain();
  assert.equal(second.get(A).state, "running");
  assert.equal(
    mock.calls.slice(beforeRecovery).some((call) => ["stop", "start", "rm", "create"].includes(call[1])),
    false,
  );
  mock.containers.get(manager.names(A).container).State.Running = false;
  second.cookie = async () => {
    throw Error("unavailable");
  };
  await second.monitor();
  await second.drain();
  assert.equal(second.get(A).state, "error");
  assert.equal(mock.containers.get(manager.names(A).container).State.Running, false);
  const count = mock.calls.length;
  await second.monitor();
  await second.drain();
  assert.equal(mock.calls.length, count);
});
test("real HTTP relay keeps all capability/cookie secrets server-side and streams original body/query", async (t) => {
  let seen;
  let logins = 0;
  const backend = http.createServer((req, res) => {
    let body = "";
    req.on("data", (x) => (body += x));
    req.on("end", () => {
      if (req.url === "/yesimbot/admin/login") {
        logins++;
        const data = JSON.parse(body);
        assert.match(data.password, /^[a-f0-9]{64}$/);
        assert.equal(req.headers.authorization, undefined);
        res.setHeader("set-cookie", ["private-backend=secret; HttpOnly; Secure"]);
        res.end("{}");
        return;
      }
      seen = { headers: req.headers, body, url: req.url };
      res.setHeader("set-cookie", "never=leak");
      res.setHeader("connection", "x-secret");
      res.setHeader("x-secret", "never");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const port = await listen(backend);
  t.after(() => backend.close());
  const { manager, root } = fixture(t);
  await listen(manager.server);
  const r = manager.register(A, { qqAccount: "11111" });
  r.state = "running";
  r.desired = "running";
  r.port = port;
  fs.mkdirSync(root + "/members/" + A);
  fs.writeFileSync(root + "/members/" + A + "/backend-password", "c".repeat(64), { mode: 0o600 });
  const response = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: manager.server.address().port,
        path: "/v1/runtimes/" + A + "/http/echo?q=one",
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          cookie: "parent=secret",
          "x-forwarded-for": "evil",
          "x-manager-token": token,
          origin: "https://evil.example",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (x) => (data += x));
        res.on("end", () => resolve({ headers: res.headers, data }));
      },
    );
    req.on("error", reject);
    req.write("one");
    req.end("two");
  });
  assert.equal(seen.body, "onetwo");
  assert.equal(seen.url, "/echo?q=one");
  assert.equal(seen.headers.authorization, undefined);
  assert.equal(seen.headers["x-manager-token"], undefined);
  assert.equal(seen.headers["x-forwarded-for"], undefined);
  assert.equal(seen.headers.cookie, "private-backend=secret");
  assert.equal(seen.headers.origin, "https://bot.example");
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(response.headers["x-secret"], undefined);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.ok(!response.data.includes("secret"));
  await api(manager, "/v1/runtimes/" + A + "/http/again?url=https%3A%2F%2Fexample.com%2Fimage");
  assert.equal(seen.url, "/again?url=https%3A%2F%2Fexample.com%2Fimage");
  assert.equal(logins, 1);
  assert.equal((await api(manager, "/v1/runtimes/" + A + "/http//evil.example")).status, 400);
  assert.equal((await api(manager, "/v1/runtimes/" + B + "/http/echo")).status, 404);
});
for (const [segment, expectedPath] of [
  ["ws", "/yesimbot/runtime/status"],
  ["desktop", "/yesimbot/api/v1/devices/desktop"],
]) {
  test(`raw WS ${segment} relay fixes backend path, strips auth/cookies, preserves both head bytes and closes on stop`, async (t) => {
    const backend = http.createServer();
    let backendHeaders,
      backendURL,
      received = "";
    backend.on("upgrade", (req, socket, head) => {
      backendHeaders = req.headers;
      backendURL = req.url;
      received += head.toString();
      socket.on("data", (d) => {
        received += d.toString();
        socket.write(d);
      });
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\nSet-Cookie: private=never\r\n\r\nHEAD",
      );
    });
    const port = await listen(backend);
    t.after(() => backend.close());
    const { manager } = fixture(t);
    await listen(manager.server);
    manager.cookie = async () => "backend=private";
    const r = manager.register(A, { qqAccount: "11111" });
    Object.assign(r, { state: "running", desired: "running", port });
    const socket = net.connect(manager.server.address().port, "127.0.0.1");
    t.after(() => socket.destroy());
    let data = "";
    socket.on("data", (d) => (data += d.toString()));
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(
      `GET /v1/runtimes/${A}/${segment} HTTP/1.1\r\nHost: manager\r\nAuthorization: Bearer ${token}\r\nCookie: parent=never\r\nX-Yesimbot-Control-Login: ${"c".repeat(64)}\r\nX-Yesimbot-Control-Proof: forged\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\nFRAME`,
    );
    for (let i = 0; i < 100 && !data.includes("FRAME"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(backendURL, expectedPath);
    assert.equal(backendHeaders.authorization, undefined);
    assert.equal(backendHeaders.cookie, "backend=private");
    if (segment === "desktop") {
      assert.equal(backendHeaders["x-yesimbot-control-login"], "c".repeat(64));
      assert.equal(
        backendHeaders["x-yesimbot-control-proof"],
        createHmac("sha256", "backend=private")
          .update(`desktop-login:${"c".repeat(64)}`)
          .digest("hex"),
      );
    }
    assert.ok(received.includes("FRAME"));
    assert.ok(data.includes("HEAD"));
    assert.ok(data.includes("FRAME"));
    assert.ok(!data.includes("private=never"));
    manager.closeSockets(A);
    await new Promise((resolve) => socket.once("close", resolve));
  });
}

test("recovery rejects changed capabilities and never starts the modified container", async (t) => {
  const mock = dockerMock();
  const { manager } = fixture(t, mock.run);
  manager.cookie = async () => "cookie";
  manager.register(A, { qqAccount: "11111" });
  manager.start(A, {});
  await manager.drain();
  const container = mock.containers.get(manager.names(A).container);
  container.HostConfig.CapAdd.push("NET_ADMIN");
  const priorStarts = mock.calls.filter((x) => x[1] === "start").length;
  await manager.reconcile();
  await manager.drain();
  assert.equal(manager.get(A).state, "error");
  assert.equal(container.State.Running, false);
  assert.equal(mock.calls.filter((x) => x[1] === "start").length, priorStarts);
});

test("three crash recoveries exhaust the persistent budget until explicit start", async (t) => {
  const mock = dockerMock();
  const { manager } = fixture(t, mock.run);
  manager.cookie = async () => "cookie";
  manager.register(A, { qqAccount: "11111" });
  manager.start(A, {});
  await manager.drain();
  for (let attempt = 0; attempt < 4; attempt++) {
    mock.containers.get(manager.names(A).container).State.Running = false;
    await manager.monitor();
    await manager.drain();
  }
  assert.equal(manager.get(A).state, "error");
  assert.equal(mock.calls.filter((x) => x[1] === "start").length, 4);
  manager.start(A, {});
  await manager.drain();
  assert.equal(manager.get(A).state, "running");
  assert.equal(manager.get(A).retries, 0);
});

test("capability normalization accepts Docker forms but rejects unknown or duplicate sets", async (t) => {
  const mock = dockerMock();
  const { manager, root } = fixture(t, mock.run);
  manager.cookie = async () => "cookie";
  manager.register(A, { qqAccount: "11111" });
  manager.start(A, {});
  await manager.drain();
  const r = manager.get(A);
  assert.equal(r.state, "running");
  const c = mock.containers.get(manager.names(A).container);
  const validate = () => manager.validateContainer(c, r, image, root + "/members/" + A, manager.names(A).network);
  for (const form of [
    ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER", "KILL"],
    ["cap_chown", "cap_dac_override", "cap_fowner", "cap_kill", "cap_setgid", "cap_setuid"],
  ]) {
    c.HostConfig.CapAdd = form;
    assert.doesNotThrow(validate);
  }
  for (const form of [
    ["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_KILL", "CAP_SETGID", "CAP_NET_ADMIN"],
    ["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_KILL", "CAP_SETGID", "SETGID"],
    ["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_KILL", "CAP_SETGID", null],
    undefined,
  ]) {
    c.HostConfig.CapAdd = form;
    assert.throws(validate, /unsafe-container/);
  }
});

test("optional plugin list matches the console catalog", () => {
  const catalog = JSON.parse(fs.readFileSync(new URL("../../packages/contracts/src/plugin-catalog.json", import.meta.url), "utf8"));
  assert.deepEqual(
    OPTIONAL_PLUGINS,
    catalog.optional.map((item) => item.name),
  );
  assert.ok(catalog.required.includes("adapter-onebot"));
  assert.ok(!OPTIONAL_PLUGINS.includes("yesimbot-computer-use"));
});
test("a stored grant naming an unknown plugin refuses the state instead of being dropped", async (t) => {
  const { root, config } = fixture(t);
  const record = { id: A, desired: "stopped", state: "stopped", plugins: ["yesimbot-quota", "yesimbot-usage"], updatedAt: new Date().toISOString() };
  fs.writeFileSync(root + "/members/runtimes.json", JSON.stringify({ version: 1, runtimes: [record] }), { mode: 0o600 });
  assert.throws(() => new RuntimeManager(config), /invalid-state/);
});
test("plugin grants are validated, written to a read-only policy mount and updated live", async (t) => {
  const mock = dockerMock(),
    { manager, root } = fixture(t, mock.run);
  manager.cookie = async () => "private-cookie";
  await listen(manager.server);
  assert.equal((await api(manager, "/v1/runtimes/" + A, "PUT", { plugins: ["yesimbot-unknown"] })).status, 400);
  assert.equal((await api(manager, "/v1/runtimes/" + A, "PUT", { plugins: ["yesimbot-xiaoheihe", "yesimbot-memorizer"], qqAccount: "11111" })).status, 200);
  assert.deepEqual(manager.records.get(A).plugins, ["yesimbot-memorizer", "yesimbot-xiaoheihe"]);
  assert.equal((await api(manager, "/v1/runtimes/" + A + "/start", "POST", { plugins: [] })).status, 400);
  assert.equal((await api(manager, "/v1/runtimes/" + A + "/start", "POST", {})).status, 200);
  await manager.drain();
  const policy = root + "/members/" + A + "/policy/plugins.json";
  assert.deepEqual(JSON.parse(fs.readFileSync(policy, "utf8")), { version: 1, plugins: ["yesimbot-memorizer", "yesimbot-xiaoheihe"] });
  assert.equal(fs.statSync(policy).mode & 0o777, 0o600);
  const mount = mock.containers.get(manager.names(A).container).Mounts.find((m) => m.Destination === "/run/yesimbot/policy");
  assert.deepEqual(mount, { Type: "bind", Source: root + "/members/" + A + "/policy", Destination: "/run/yesimbot/policy", RW: false });
  assert.equal((await api(manager, "/v1/runtimes/" + A, "PUT", { plugins: [] })).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(policy, "utf8")).plugins, []);
  assert.equal(manager.records.get(A).state, "running");
});
test("records without a plugin list keep every optional plugin", async (t) => {
  const mock = dockerMock(),
    { manager, root } = fixture(t, mock.run);
  manager.cookie = async () => "private-cookie";
  manager.register(A, { qqAccount: "11111" });
  delete manager.records.get(A).plugins;
  manager.start(A, {});
  await manager.drain();
  assert.deepEqual(JSON.parse(fs.readFileSync(root + "/members/" + A + "/policy/plugins.json", "utf8")).plugins, OPTIONAL_PLUGINS);
});

test("external runtime forwards lifecycle and policy without touching Docker; OneBot preserves only validated identity headers", async (t) => {
  let state = "stopped",
    backendHeaders,
    backendURL;
  const operations = [],
    calls = [];
  const control = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + "d".repeat(64));
    let data = "";
    req.on("data", (part) => (data += part));
    req.on("end", () => {
      operations.push({ path: req.url, body: data && JSON.parse(data) });
      if (req.url === "/start") state = "running";
      if (req.url === "/stop") state = "stopped";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ runtime: { id: A, state, version: "tested" } }));
    });
  });
  const backend = http.createServer();
  backend.on("upgrade", (req, socket) => {
    backendHeaders = req.headers;
    backendURL = req.url;
    socket.on("data", (data) => socket.write(data));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\nCONNECTED");
  });
  const { manager, config, root } = fixture(t, async (...args) => {
    calls.push(args);
    throw Error("unexpected Docker call");
  });
  const controlPort = await listen(control),
    backendPort = await listen(backend);
  t.after(() => {
    control.closeAllConnections();
    control.close();
    backend.close();
  });
  fs.writeFileSync(root + "/host-token", "d".repeat(64), { mode: 0o600 });
  fs.writeFileSync(root + "/host-password", "e".repeat(64), { mode: 0o600 });
  manager.config = validateConfig({
    ...config,
    externalRuntimes: [{ id: A, name: "Test computer", controlPort, backendPort, tokenFile: root + "/host-token", passwordFile: root + "/host-password" }],
  });
  await listen(manager.server);
  const base = "/v1/runtimes/" + A;
  assert.equal((await api(manager, base)).data.runtime.state, "stopped");
  assert.equal((await api(manager, base + "/start", "POST", {})).data.runtime.state, "running");
  assert.deepEqual(operations.find((item) => item.path === "/policy").body, manager.contextPolicy);
  assert.ok(operations.findIndex((item) => item.path === "/policy") < operations.findIndex((item) => item.path === "/start"));
  assert.equal((await api(manager, base, "DELETE")).status, 400);
  assert.equal((await api(manager, base + "/start", "POST", { qqAccount: "99999" })).status, 400);
  const socket = net.connect(manager.server.address().port, "127.0.0.1");
  t.after(() => socket.destroy());
  let data = "";
  socket.on("data", (part) => (data += part));
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(
    `GET ${base}/onebot HTTP/1.1\r\nHost: manager\r\nAuthorization: Bearer ${token}\r\nCookie: parent=secret\r\nX-Self-ID: 123456789\r\nX-Client-Role: Universal\r\nX-Other-Secret: hidden\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  for (let i = 0; i < 100 && !data.includes("CONNECTED"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(backendURL, "/onebot");
  assert.equal(backendHeaders["x-self-id"], "123456789");
  assert.equal(backendHeaders["x-client-role"], "Universal");
  for (const key of ["authorization", "cookie", "x-other-secret", "origin"]) assert.equal(backendHeaders[key], undefined);
  const closed = new Promise((resolve) => socket.once("close", resolve));
  assert.equal((await api(manager, base + "/stop", "POST", {})).data.runtime.state, "stopped");
  await closed;
  assert.equal(calls.length, 0);
  assert.equal(manager.records.size, 0);
});

/** A host with pre-retirement computer artifacts; it never simulates provisioning new ones. */
function legacyComputerHost(t, records = []) {
  const mock = dockerMock();
  const volumes = new Map(),
    loops = new Map(),
    gatewayCalls = [],
    commands = [];
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yb-retired-computer-")));
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(root + "/token", token, { mode: 0o600 });
  fs.mkdirSync(root + "/members", { mode: 0o700 });
  fs.writeFileSync(root + "/members/runtimes.json", JSON.stringify({ version: 1, runtimes: records }), { mode: 0o600 });
  const run = async (command, args) => {
    commands.push([command, ...args]);
    if (args.includes("ensure-runtime")) {
      const tenant = args[args.indexOf("--tenant") + 1],
        output = args[args.indexOf("--output") + 1];
      fs.writeFileSync(output, JSON.stringify({ version: 1, tenantId: tenant, token: "c".repeat(64) }), { mode: 0o600 });
      return "";
    }
    if (args.includes("revoke-runtime")) return "";
    if (command === "losetup") {
      if (args[0] === "-j") return loops.has(args[1]) ? loops.get(args[1]) + ": []: (" + args[1] + ")\n" : "";
      if (args[0] === "-d") {
        for (const [file, device] of loops) if (device === args[1]) loops.delete(file);
        return "";
      }
      throw Error("retired computer disk creation attempted");
    }
    if (command === "docker" && args[0] === "volume") {
      if (args[1] === "ls") return [...volumes.keys()].join("\n");
      if (args[1] === "inspect") return JSON.stringify([volumes.get(args[2])]);
      if (args[1] === "rm") return void volumes.delete(args[2]) ?? "";
      throw Error("retired computer volume creation attempted");
    }
    if (command === "docker" && args[0] === "network" && args[1] === "rm") return void mock.networks.delete(args[2]) ?? "";
    return mock.run(command, args);
  };
  const legacyComputer = { image: "yesimbot-computer:tested", cpus: 1, memoryMB: 1024, diskGB: 5 };
  const config = {
    rootDir: root + "/members",
    tokenFile: root + "/token",
    image: "yesimbot:tested",
    publicOrigin: "https://bot.example",
    deviceGateway: { origin: "https://devices.example", cli: root + "/gateway.cjs", stateDir: root + "/gateway", localPort: 17401, controlPort: 17400 },
    computer: legacyComputer,
  };
  const manager = new RuntimeManager(config, {
    run,
    readinessAttempts: 1,
    retryDelay: 0,
    fetch: async (url, init) => {
      const pathname = new URL(url).pathname;
      gatewayCalls.push([init.method, pathname, init.headers.authorization]);
      if (pathname === "/v1/pairings") throw Error("retired computer pairing attempted");
      if (init.method === "GET") return new Response(JSON.stringify([{ deviceId: "44444444-4444-4444-8444-444444444441" }]), { status: 200 });
      return new Response(JSON.stringify({ revoked: true }), { status: 200 });
    },
  });
  manager.cookie = async () => "private-cookie";
  const seedComputer = (id) => {
    const name = "yesimbot-computer-" + id,
      directory = root + "/members/" + id + "/computer",
      disk = directory + "/disk.img";
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(disk, "legacy computer disk", { mode: 0o600 });
    mock.containers.set(name, { Config: { Labels: { "io.yesimbot.runtime": id } }, State: { Running: true } });
    volumes.set(name, { Driver: "local", Labels: { "io.yesimbot.runtime": id }, Options: { device: "/dev/loop" + loops.size } });
    loops.set(disk, "/dev/loop" + loops.size);
    return { container: mock.containers.get(name), disk };
  };
  t.after(async () => {
    if (manager.server.listening) await manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { manager, root, config, legacyComputer, mock, volumes, loops, gatewayCalls, commands, seedComputer };
}

function assertNoComputerWork(commands, gatewayCalls) {
  assert.deepEqual(
    commands.filter(
      (call) => ["losetup", "mkfs.ext4", "e2fsck", "resize2fs"].includes(call[0]) || call.some((value) => String(value).includes("yesimbot-computer-")),
    ),
    [],
  );
  assert.deepEqual(gatewayCalls, []);
}

test("legacy computer config is ignored while normal device gateway configuration is preserved", (t) => {
  const { config, root } = fixture(t);
  const deviceGateway = { origin: "https://devices.example", cli: root + "/gateway.cjs", stateDir: root + "/gateway", localPort: 17401, controlPort: 17400 };
  const validated = validateConfig({ ...config, deviceGateway, computer: { image: "yesimbot-computer:old", cpus: 2, memoryMB: 2048, diskGB: 10 } });
  assert.ok(!Object.hasOwn(validated, "computer"));
  assert.deepEqual(validated.deviceGateway, deviceGateway);
});

test("creating and updating a friend never provisions a managed computer even with stale in-memory config", async (t) => {
  const { manager, root, legacyComputer, commands, gatewayCalls } = legacyComputerHost(t);
  manager.config.computer = legacyComputer;
  await listen(manager.server);
  const response = await api(manager, "/v1/runtimes/" + A, "PUT", {});
  assert.equal(response.status, 200);
  await manager.drain();
  assert.equal(manager.get(A).state, "stopped");
  assert.ok(!Object.hasOwn(response.data.runtime, "computer"));
  assert.ok(!fs.existsSync(root + "/members/" + A));
  manager.register(A, { plugins: [] });
  await manager.drain();
  assertNoComputerWork(commands, gatewayCalls);
  assert.deepEqual(commands, []);
});

test("start, reconcile, monitor and stop ignore legacy computer records and preserve existing computers", async (t) => {
  const computer = { state: "ready", deviceId: "44444444-4444-4444-8444-444444444441", pending: "repair", spec: { cpus: 1, memoryMB: 1024, diskGB: 5 } };
  const records = [
    { id: A, desired: "stopped", state: "stopped", computer },
    { id: B, desired: "stopped", state: "stopped", computer: { ...computer, pending: "configure" } },
  ];
  const { manager, root, legacyComputer, mock, commands, gatewayCalls, seedComputer } = legacyComputerHost(t, records);
  manager.config.computer = legacyComputer;
  const b = seedComputer(B);
  manager.start(A, {});
  await manager.drain();
  assert.equal(manager.get(A).state, "running");
  assert.ok(!Object.hasOwn(manager.view(manager.get(A)), "computer"));
  assert.ok(!mock.containers.has("yesimbot-computer-" + A));
  assert.ok(!fs.existsSync(root + "/members/" + A + "/computer"));
  const name = manager.names(A).container,
    oldBot = mock.containers.get(name);
  assert.ok(oldBot.State.Running);
  assert.ok(oldBot.Config.Env.includes("YESIMBOT_DEVICE_GATEWAY=https://devices.example"));
  assert.ok(oldBot.Config.Env.includes("YESIMBOT_DEVICE_LOCAL_GATEWAY=http://172.30.0.1:17401"));
  assert.ok(!oldBot.Config.Env.some((value) => value.startsWith("YESIMBOT_COMPUTER_FILE=")));
  assert.equal(JSON.parse(fs.readFileSync(root + "/members/" + A + "/policy/device-credential.json")).tenantId, A);
  const a = seedComputer(A);
  await manager.reconcile();
  await manager.drain();
  const bot = mock.containers.get(name);
  assert.equal(manager.get(A).state, "running");
  assert.equal(manager.get(B).state, "stopped");
  assert.ok(!bot.Config.Env.some((value) => value.startsWith("YESIMBOT_COMPUTER_FILE=")));
  assert.ok(!fs.existsSync(root + "/members/" + A + "/policy/computer.json"));
  await manager.monitor();
  await manager.drain();
  manager.stop(A);
  await manager.drain();
  assert.equal(manager.get(A).state, "stopped");
  assert.ok(!bot.State.Running);
  for (const artifact of [a, b]) {
    assert.ok(artifact.container.State.Running);
    assert.equal(fs.readFileSync(artifact.disk, "utf8"), "legacy computer disk");
  }
  assertNoComputerWork(commands, gatewayCalls);
});

test("retired manager computer endpoints return 404 without state, Docker or gateway side effects", async (t) => {
  const { manager, root, legacyComputer, commands, gatewayCalls } = legacyComputerHost(t);
  manager.config.computer = legacyComputer;
  manager.register(A, {});
  manager.get(A).computer = { state: "ready", pending: "repair" };
  manager.persist();
  const before = fs.readFileSync(root + "/members/runtimes.json", "utf8");
  await listen(manager.server);
  const requests = [
    ["GET", "/v1/computers"],
    ["POST", "/v1/computers", {}],
    ["GET", "/v1/computers/defaults"],
    ["PUT", "/v1/computers/defaults", { cpus: 2, memoryMB: 2048, diskGB: 8 }],
    ...["start", "stop", "restart", "repair", "configure"].map((action) => [
      "POST",
      "/v1/runtimes/" + A + "/computer",
      { action, spec: { cpus: 2, memoryMB: 2048, diskGB: 8 } },
    ]),
  ];
  for (const [method, target, body] of requests) assert.equal((await api(manager, target, method, body)).status, 404, method + " " + target);
  await manager.drain();
  assert.equal(fs.readFileSync(root + "/members/runtimes.json", "utf8"), before);
  assert.ok(!fs.existsSync(root + "/members/computer-defaults.json"));
  assertNoComputerWork(commands, gatewayCalls);
  assert.deepEqual(commands, []);
});

test("explicit friend deletion still cleans only that friend's owned legacy computer artifacts", async (t) => {
  const { manager, root, mock, volumes, loops, gatewayCalls, commands, seedComputer } = legacyComputerHost(t);
  await listen(manager.server);
  for (const id of [A, B]) {
    manager.register(id, {});
    manager.start(id, {});
  }
  await manager.drain();
  seedComputer(A);
  const other = seedComputer(B);
  commands.length = 0;
  const response = await api(manager, "/v1/runtimes/" + A, "DELETE");
  assert.equal(response.status, 200);
  assert.equal(response.data.runtime.state, "deleting");
  await manager.drain();
  assert.equal((await api(manager, "/v1/runtimes/" + A)).status, 404);
  assert.ok(!mock.containers.has("yesimbot-member-" + A) && !mock.containers.has("yesimbot-computer-" + A));
  assert.ok(!volumes.has("yesimbot-computer-" + A) && !mock.networks.has("yesimbot-member-" + A));
  assert.ok(![...loops.keys()].some((file) => file.includes(A)));
  assert.ok(!fs.existsSync(root + "/members/" + A));
  assert.deepEqual(
    gatewayCalls.map(([method, pathname]) => method + " " + pathname),
    ["GET /v1/devices", "DELETE /v1/devices/44444444-4444-4444-8444-444444444441"],
  );
  assert.ok(commands.some((call) => call.includes("revoke-runtime") && call.includes(A)));
  const deletes = commands.filter((call) => call[0] === "iptables" && call.includes("-D"));
  assert.ok(deletes.length > 0 && deletes.every((call) => call.includes("yb" + A.replaceAll("-", "").slice(0, 12))));
  assert.equal(manager.get(B).state, "running");
  assert.ok(other.container.State.Running);
  assert.equal(fs.readFileSync(other.disk, "utf8"), "legacy computer disk");
  assert.ok(!JSON.parse(fs.readFileSync(root + "/members/runtimes.json")).runtimes.some((record) => record.id === A));
});

test("friend deletion refuses a legacy computer belonging to another runtime", async (t) => {
  const { manager, root, mock, volumes, loops, commands, seedComputer } = legacyComputerHost(t);
  manager.register(A, {});
  const artifact = seedComputer(A);
  artifact.container.Config.Labels["io.yesimbot.runtime"] = B;
  manager.remove(A);
  await manager.drain();
  assert.equal(manager.get(A).state, "error");
  assert.ok(artifact.container.State.Running);
  assert.ok(mock.containers.has("yesimbot-computer-" + A));
  assert.ok(volumes.has("yesimbot-computer-" + A));
  assert.ok(loops.has(artifact.disk));
  assert.ok(fs.existsSync(root + "/members/" + A));
  assert.ok(!commands.some((call) => call[0] === "docker" && ["stop", "rm"].includes(call[1])));
});

test("egress grants only a root-selected gateway port and rejects invalid policy", (t) => {
  const { manager, config } = fixture(t);
  for (const egress of [
    { port: 80, directHosts: "" },
    { port: 18443, directHosts: "*" },
    { port: 18443, directHosts: "", extra: true },
  ])
    assert.throws(() => validateConfig({ ...config, egress }));
  manager.config = validateConfig({ ...config, egress: { port: 18443, directHosts: "newapi.internal.example" } });
  const rules = manager.firewallRules("yb111111111111", "172.30.0.1");
  assert.ok(rules.some(([chain, args]) => chain === "INPUT" && args.includes("18443") && args.includes("172.30.0.1") && args.includes("ACCEPT")));
  assert.ok(rules.some(([chain, args]) => chain === "DOCKER-USER" && args.includes("REJECT")));
});

test("manual control login proof is bound to the child cookie and fixed control endpoints", () => {
  const login = "a".repeat(64),
    cookie = "child=private";
  for (const endpoint of ["/yesimbot/api/v1/devices/control", "/yesimbot/api/v1/devices/desktop"]) {
    const identity = desktopIdentityHeaders({ "x-yesimbot-control-login": login, "x-yesimbot-control-proof": "forged" }, endpoint, cookie);
    assert.equal(identity["x-yesimbot-control-login"], login);
    assert.equal(identity["x-yesimbot-control-proof"], createHmac("sha256", cookie).update(`desktop-login:${login}`).digest("hex"));
  }
  assert.deepEqual(desktopIdentityHeaders({ "x-yesimbot-control-login": login }, "/yesimbot/admin/accounts", cookie), {});
  assert.deepEqual(desktopIdentityHeaders({ "x-yesimbot-control-login": "bad" }, "/yesimbot/api/v1/devices/control", cookie), {});
});

/** dockerMock plus the ops commands: stats, supervisorctl and the release marker. */
function opsMock() {
  const mock = dockerMock();
  const status = new Map();
  const release = new Map();
  const restarts = [];
  const run = async (cmd, args) => {
    if (args[0] === "stats") {
      mock.calls.push([cmd, ...args]);
      return JSON.stringify({ Name: args.at(-1), CPUPerc: "1.95%", MemUsage: "612.6MiB / 1GiB" }) + "\n";
    }
    if (args[0] === "exec") {
      mock.calls.push([cmd, ...args]);
      const name = args[1];
      if (args[2] === "cat") {
        if (!release.has(name)) throw Error("missing");
        return release.get(name);
      }
      if (args[2] === "sh") return status.get(name) ?? "";
      if (args.includes("restart")) {
        restarts.push([name, args.at(-1)]);
        return "";
      }
    }
    return mock.run(cmd, args);
  };
  return { ...mock, run, status, release, restarts };
}
const TABLE = "koishi                           RUNNING   pid 15, uptime 0:19:26\nnapcat                           RUNNING   pid 16, uptime 5 days, 7:50:47\n";

test("owner config is validated and never names a member container", (t) => {
  const { config } = fixture(t);
  assert.deepEqual(validateConfig({ ...config, owner: { container: "yesimbot-preview" } }).owner, { container: "yesimbot-preview" });
  assert.equal(validateConfig(config).owner, undefined);
  for (const owner of [{}, { container: "-x" }, { container: "a b" }, { container: "yesimbot-member-" + A }, { container: "x", extra: 1 }, "x", null, []])
    assert.throws(() => validateConfig({ ...config, owner }), /invalid-config/);
});

test("ops lists the owner first, then every member, with parsed stats, programs and release", async (t) => {
  const mock = opsMock();
  const { manager, config } = fixture(t, mock.run);
  manager.config = validateConfig({ ...config, owner: { container: "yesimbot-preview" } });
  manager.cookie = async () => "cookie";
  manager.register(A, { qqAccount: "11111" });
  manager.register(B, {});
  manager.start(A, {});
  await manager.drain();
  mock.containers.set("yesimbot-preview", { Config: { Labels: {} }, State: { Running: true, StartedAt: "2026-11-01T00:00:00Z" } });
  const member = manager.names(A).container;
  mock.containers.get(member).State.StartedAt = "2026-11-19T02:41:05.540259233Z";
  mock.status.set(member, TABLE);
  mock.status.set("yesimbot-preview", "koishi RUNNING pid 9, uptime 1:00:00\nnapcat STOPPED Not started\nunrelated RUNNING pid 1\n");
  const marker = { commit: "abc1234", deployId: "d1", deployedAt: "2026-11-19T03:00:00Z" };
  mock.release.set(member, JSON.stringify(marker));
  mock.release.set("yesimbot-preview", "{not json");
  await listen(manager.server);
  const { status, data } = await api(manager, "/v1/ops");
  assert.equal(status, 200);
  assert.ok(!Number.isNaN(Date.parse(data.generatedAt)));
  assert.deepEqual(
    data.instances.map((item) => item.target),
    ["owner", A, B],
  );
  assert.deepEqual(data.instances[0], {
    target: "owner",
    container: { name: "yesimbot-preview", running: true, startedAt: "2026-11-01T00:00:00Z" },
    memory: { usedBytes: Math.round(612.6 * 1024 ** 2), limitBytes: 1024 ** 3 },
    cpuPercent: 1.95,
    programs: { koishi: { state: "RUNNING", pid: 9, uptimeSeconds: 3600 }, napcat: { state: "STOPPED" } },
  });
  assert.deepEqual(data.instances[1], {
    target: A,
    container: { name: member, running: true, startedAt: "2026-11-19T02:41:05.540259233Z" },
    memory: { usedBytes: Math.round(612.6 * 1024 ** 2), limitBytes: 1024 ** 3 },
    cpuPercent: 1.95,
    programs: {
      koishi: { state: "RUNNING", pid: 15, uptimeSeconds: 1166 },
      napcat: { state: "RUNNING", pid: 16, uptimeSeconds: 5 * 86400 + 7 * 3600 + 50 * 60 + 47 },
    },
    release: marker,
  });
  assert.deepEqual(data.instances[2], { target: B, container: { name: manager.names(B).container, running: false }, programs: {} });
  assert.equal((await api(manager, "/v1/ops", "GET", undefined, "0".repeat(64))).status, 401);
});

test("ops without an owner config and with a foreign member container never touch that container", async (t) => {
  const mock = opsMock();
  const { manager } = fixture(t, mock.run);
  manager.register(A, {});
  mock.containers.set(manager.names(A).container, { Config: { Labels: {} }, State: { Running: true } });
  await listen(manager.server);
  const { data } = await api(manager, "/v1/ops");
  assert.deepEqual(data.instances, [{ target: A, container: { name: manager.names(A).container, running: false }, programs: {} }]);
  assert.ok(!mock.calls.some((call) => call[1] === "exec" || call[1] === "stats"));
  assert.equal((await api(manager, "/v1/ops/owner/restart", "POST", { program: "napcat" })).status, 404);
});

test("restarting a member koishi runs under its lock, clears cookie and sockets, waits for readiness", async (t) => {
  const mock = opsMock();
  const { manager } = fixture(t, mock.run);
  let logins = 0,
    failures = 2;
  manager.cookie = async () => "cookie";
  manager.register(A, { qqAccount: "11111" });
  manager.start(A, {});
  await manager.drain();
  const member = manager.names(A).container;
  mock.status.set(member, TABLE);
  manager.cookie = async () => {
    logins++;
    if (failures-- > 0) throw Error("not yet");
    return "fresh";
  };
  manager.cookies.set(A, { value: "stale", expiry: Date.now() + 1e6 });
  manager.readinessAttempts = 5;
  let closed = 0;
  manager.closeSockets = () => closed++;
  await listen(manager.server);
  assert.equal((await api(manager, "/v1/ops/" + A + "/restart", "POST", { program: "bogus" })).status, 400);
  assert.equal((await api(manager, "/v1/ops/" + A + "/restart", "POST", { program: "napcat", extra: 1 })).status, 400);
  assert.equal((await api(manager, "/v1/ops/not-a-uuid/restart", "POST", { program: "koishi" })).status, 404);
  assert.equal((await api(manager, "/v1/ops/" + B + "/restart", "POST", { program: "koishi" })).status, 404);
  const response = await api(manager, "/v1/ops/" + A + "/restart", "POST", { program: "koishi" });
  assert.equal(response.status, 200);
  assert.equal(response.data.instance.target, A);
  assert.deepEqual(mock.restarts, [[member, "koishi"]]);
  assert.equal(logins, 3);
  assert.ok(!manager.cookies.has(A));
  assert.ok(closed >= 1);
  // The container is untouched: no stop, rm or create.
  assert.ok(!mock.calls.some((call) => ["stop", "rm"].includes(call[1])));
  // Monitor leaves a freshly restarted member alone even if Docker still reports it unhealthy.
  mock.containers.get(member).State.Health = { Status: "unhealthy" };
  const before = mock.calls.length;
  await manager.monitor();
  await manager.drain();
  assert.equal(mock.calls.length, before);
  assert.equal(manager.get(A).retries ?? 0, 0);
});

test("a failed member restart reports an error without stopping the container; unavailable members answer 409", async (t) => {
  const mock = opsMock();
  const { manager } = fixture(t, mock.run);
  manager.cookie = async () => "cookie";
  manager.register(A, { qqAccount: "11111" });
  manager.start(A, {});
  await manager.drain();
  manager.cookie = async () => {
    throw Error("down");
  };
  await listen(manager.server);
  assert.equal((await api(manager, "/v1/ops/" + A + "/restart", "POST", { program: "koishi" })).status, 502);
  assert.equal(manager.get(A).state, "running");
  assert.ok(mock.containers.get(manager.names(A).container).State.Running);
  assert.ok(!mock.calls.some((call) => call[1] === "stop"));
  manager.get(A).desired = "stopped";
  assert.equal((await api(manager, "/v1/ops/" + A + "/restart", "POST", { program: "napcat" })).status, 409);
  manager.get(A).desired = "running";
  manager.get(A).deleting = true;
  assert.equal((await api(manager, "/v1/ops/" + A + "/restart", "POST", { program: "napcat" })).status, 409);
});

test("owner napcat restarts synchronously while owner koishi answers 202 before it restarts", async (t) => {
  const mock = opsMock();
  const { manager, config } = fixture(t, mock.run);
  manager.config = validateConfig({ ...config, owner: { container: "yesimbot-preview" } });
  mock.containers.set("yesimbot-preview", { Config: { Labels: {} }, State: { Running: true } });
  mock.status.set("yesimbot-preview", TABLE);
  await listen(manager.server);
  const napcat = await api(manager, "/v1/ops/owner/restart", "POST", { program: "napcat" });
  assert.equal(napcat.status, 200);
  assert.equal(napcat.data.instance.target, "owner");
  assert.deepEqual(mock.restarts, [["yesimbot-preview", "napcat"]]);
  const koishi = await api(manager, "/v1/ops/owner/restart", "POST", { program: "koishi" });
  assert.equal(koishi.status, 202);
  assert.deepEqual(koishi.data, { accepted: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(mock.restarts.at(-1), ["yesimbot-preview", "koishi"]);
});

test("patchedFrom lets an in-place patched container keep running; stale or foreign images are still refused or rebuilt", async (t) => {
  const mock = dockerMock(),
    patched = "sha256:" + "d".repeat(64),
    other = "sha256:" + "e".repeat(64);
  const { manager, root, config } = fixture(t, mock.run);
  manager.cookie = async () => "cookie";
  manager.register(A, { qqAccount: "11111" });
  manager.start(A, {});
  await manager.drain();
  const name = manager.names(A).container;
  // Deploy patches the running container in place and records the image it came from.
  mock.containers.get(name).Image = patched;
  const created = () => mock.calls.filter((call) => call[1] === "create").length;
  manager.get(A).patchedFrom = patched;
  manager.persist();
  assert.equal(JSON.parse(fs.readFileSync(config.rootDir + "/runtimes.json", "utf8")).runtimes[0].patchedFrom, patched);
  assert.equal(new RuntimeManager(config).get(A).patchedFrom, patched);
  manager.update(manager.get(A), "starting");
  await manager.provision(manager.get(A));
  assert.equal(created(), 1);
  assert.equal(manager.get(A).patchedFrom, patched);
  // A running container on a third image is never adopted.
  mock.containers.get(name).Image = other;
  await assert.rejects(manager.provision(manager.get(A)), /unsafe-container/);
  // Stopped on a stale image: removed and recreated from the pin, patchedFrom dropped.
  mock.containers.get(name).State.Running = false;
  await manager.provision(manager.get(A));
  assert.equal(created(), 2);
  assert.equal(mock.containers.get(name).Image, image);
  assert.equal(manager.get(A).patchedFrom, undefined);
  // Stopped on the patched image: kept, restarted as is.
  manager.get(A).patchedFrom = patched;
  mock.containers.get(name).Image = patched;
  mock.containers.get(name).State.Running = false;
  await manager.provision(manager.get(A));
  assert.equal(created(), 2);
  assert.ok(mock.containers.get(name).State.Running);
  // Foreign labels are still refused even for a stopped stale image.
  mock.containers.get(name).Config.Labels = {};
  mock.containers.get(name).State.Running = false;
  mock.containers.get(name).Image = other;
  await assert.rejects(manager.provision(manager.get(A)), /foreign-runtime/);
  fs.writeFileSync(root + "/members/runtimes.json", JSON.stringify({ version: 1, runtimes: [{ id: A, desired: "stopped", patchedFrom: "latest" }] }), {
    mode: 0o600,
  });
  assert.throws(() => new RuntimeManager(config), /invalid-state/);
});
