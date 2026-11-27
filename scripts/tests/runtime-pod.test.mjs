import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RuntimeManager, validateConfig } from "../runtime-manager.mjs";
import { NAPCAT_WRAPPER_TARGET, podNames } from "../runtime-pod.mjs";

const A = "11111111-1111-4111-8111-111111111111";
const token = "b".repeat(64);
const IMAGES = {
  "yesimbot-app:1": "sha256:" + "1".repeat(64),
  "yesimbot-app:2": "sha256:" + "2".repeat(64),
  napcat: "sha256:" + "3".repeat(64),
  "yesimbot-wechat:1": "sha256:" + "4".repeat(64),
  single: "sha256:" + "5".repeat(64),
};
const names = podNames(A);

/** Docker as far as the manager sees it: `create` arguments become what `inspect` reports. */
function docker() {
  const calls = [];
  const containers = new Map();
  const networks = new Map();
  let clock = Date.parse("2026-11-25T00:00:00Z");
  let ids = 0;
  let port = 23000;
  const size = (value) => Number(value.replace(/m$/, "")) * 1024 * 1024;
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "iptables") {
      if (args.includes("-C")) throw Error("absent");
      return "";
    }
    if (args[0] === "image") {
      const id = IMAGES[args[2]];
      if (!id) throw Error("no such image");
      return JSON.stringify([{ Id: id }]);
    }
    if (args[0] === "network" && args[1] === "ls") return [...networks.keys()].join("\n");
    if (args[0] === "network" && args[1] === "create") {
      const name = args.at(-1);
      networks.set(name, {
        Labels: { "io.yesimbot.runtime": A },
        Driver: "bridge",
        EnableIPv6: false,
        Options: { "com.docker.network.bridge.enable_icc": "false", "com.docker.network.bridge.name": args[args.indexOf("--opt") + 1].split("=")[1] },
        IPAM: { Config: [{ Subnet: "172.31.0.0/16", Gateway: "172.31.0.1" }] },
      });
      return "";
    }
    if (args[0] === "network" && args[1] === "inspect") return JSON.stringify([networks.get(args[2])]);
    if (args[0] === "network" && args[1] === "rm") return void networks.delete(args[2]) ?? "";
    if (args[0] === "volume" && args[1] === "ls") return "";
    if (args[0] === "ps") return [...containers.keys()].join("\n");
    if (args[0] === "inspect") return JSON.stringify([containers.get(args[1])]);
    if (args[0] === "stats") return JSON.stringify({ MemUsage: "100MiB / 1GiB", CPUPerc: "1.00%" });
    if (args[0] === "exec")
      return args.join(" ").includes(" status")
        ? "koishi                           RUNNING   pid 7, uptime 0:01:00\nnapcat                           STOPPED   Not started\n"
        : "";
    if (args[0] === "create") {
      const values = (flag) => args.flatMap((x, i) => (x === flag ? [args[i + 1]] : []));
      const value = (flag) => values(flag)[0];
      const image = args.find((x, i) => i > 0 && !x.startsWith("-") && !args[i - 1].startsWith("-") && /^sha256:/.test(x));
      const mode = value("--network");
      const target = mode.startsWith("container:") ? mode.slice(10) : undefined;
      const joined = target && (containers.get(target) ?? [...containers.values()].find((c) => c.Id === target));
      if (mode.startsWith("container:") && !joined) throw Error("no such container");
      const published = value("--publish");
      containers.set(value("--name"), {
        Id: "c" + String(++ids).padStart(63, "0"),
        Image: image,
        Config: {
          Labels: Object.fromEntries(values("--label").map((x) => x.split("="))),
          Env: values("--env"),
          Entrypoint: value("--entrypoint") ? [value("--entrypoint")] : null,
          Cmd: args.slice(args.indexOf(image) + 1),
          WorkingDir: value("--workdir") ?? "",
        },
        HostConfig: {
          CapDrop: values("--cap-drop"),
          CapAdd: values("--cap-add").map((cap) => "CAP_" + cap),
          SecurityOpt: values("--security-opt"),
          Sysctls: Object.fromEntries(values("--sysctl").map((x) => x.split("="))),
          NanoCpus: Math.round(Number(value("--cpus")) * 1e9),
          Memory: size(value("--memory")),
          MemorySwap: size(value("--memory-swap")),
          PidsLimit: Number(value("--pids-limit")),
          ShmSize: size(value("--shm-size")),
          LogConfig: { Type: value("--log-driver"), Config: Object.fromEntries(values("--log-opt").map((x) => x.split("="))) },
          NetworkMode: joined ? "container:" + joined.Id : mode,
          RestartPolicy: { Name: value("--restart") },
          PortBindings: published ? { "5140/tcp": [{ HostIp: published.split(":")[0], HostPort: "" }] } : {},
        },
        Mounts: values("--mount").map((x) => {
          const p = Object.fromEntries(x.split(",").map((y) => y.split("=")));
          return { Type: p.type, Source: p.src, Destination: p.dst, RW: !x.endsWith(",readonly") };
        }),
        State: { Running: false, Status: "created" },
        NetworkSettings: {
          Networks: joined ? {} : { [mode]: {} },
          Ports: published ? { "5140/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port++) }] } : {},
        },
      });
      return "";
    }
    if (args[0] === "rm") {
      containers.delete(args.at(-1));
      return "";
    }
    if (["start", "stop", "restart"].includes(args[0])) {
      const c = containers.get(args.at(-1));
      c.State =
        args[0] === "stop"
          ? { Running: false, Status: "exited" }
          : { Running: true, Status: "running", Pid: 40 + ids, StartedAt: new Date((clock += 1000)).toISOString() };
      return "";
    }
    throw Error("unexpected command " + args.join(" "));
  };
  return { run, calls, containers };
}

function fixture(t, { pod = true } = {}) {
  const mock = docker();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yb-pod-")));
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(root + "/token", token, { mode: 0o600 });
  const config = {
    rootDir: root + "/members",
    tokenFile: root + "/token",
    image: "single",
    publicOrigin: "https://bot.example",
    ...(pod ? { pod: { app: "yesimbot-app:1", napcat: "napcat", wechat: "yesimbot-wechat:1" } } : {}),
  };
  const manager = new RuntimeManager(config, { run: mock.run, readinessAttempts: 1, retryDelay: 0 });
  const ready = [];
  manager.cookie = async () => {
    ready.push(mock.calls.length);
    return "private-cookie";
  };
  t.after(async () => {
    if (manager.server.listening) await manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { manager, mock, root, config, ready, directory: root + "/members/" + A };
}

const index = (calls, ...command) => calls.findIndex((call) => command.every((part, i) => call[i + 1] === part));

test("a new account runs as four containers on the namespace of the one that publishes", async (t) => {
  const { manager, mock, directory, ready } = fixture(t);
  manager.register(A, { qqAccount: "234567890" });
  manager.start(A, {});
  await manager.drain();
  const r = manager.records.get(A);
  assert.equal(r.state, "running");
  assert.equal(r.layout, "pod");
  const [net, app, napcat, wechat] = ["net", "app", "napcat", "wechat"].map((part) => mock.containers.get(names[part]));
  for (const c of [net, app, napcat, wechat]) {
    assert.equal(c.State.Running, true);
    assert.equal(c.Config.Labels["io.yesimbot.runtime"], A);
    assert.deepEqual(c.HostConfig.SecurityOpt, ["no-new-privileges:true"]);
    assert.deepEqual(c.HostConfig.CapDrop, ["ALL"]);
  }
  // Only the namespace's owner is on the bridge and publishes, on loopback only.
  assert.equal(net.HostConfig.NetworkMode, "yesimbot-member-" + A);
  assert.equal(r.port, Number(net.NetworkSettings.Ports["5140/tcp"][0].HostPort));
  assert.deepEqual(net.HostConfig.CapAdd, []);
  for (const c of [app, napcat, wechat]) {
    assert.equal(c.HostConfig.NetworkMode, "container:" + net.Id);
    assert.deepEqual(c.HostConfig.PortBindings, {});
  }
  // The unmodified NapCat image, with the logout wrapper mounted read-only, QQ's data and NapCat's settings; its
  // output (login QR codes, tokens) reaches no container log.
  assert.equal(napcat.Image, IMAGES.napcat);
  assert.equal(napcat.HostConfig.LogConfig.Type, "none");
  for (const c of [net, app, wechat]) assert.deepEqual(c.HostConfig.LogConfig, { Type: "json-file", Config: { "max-size": "10m", "max-file": "2" } });
  assert.deepEqual(napcat.Config.Cmd, [NAPCAT_WRAPPER_TARGET]);
  assert.ok(napcat.Config.Env.includes("ACCOUNT=234567890"));
  assert.deepEqual(
    napcat.Mounts.map((m) => [m.Destination, m.RW]),
    [
      ["/app/.config/QQ", true],
      ["/app/napcat/config", true],
      ["/app/napcat/plugins", true],
      [NAPCAT_WRAPPER_TARGET, false],
    ],
  );
  // The app holds no QQ data; agent-wechat sees only its own directory.
  assert.deepEqual(
    app.Mounts.map((m) => m.Source),
    [directory + "/koishi", directory + "/napcat-config", directory + "/backend-password", directory + "/policy"],
  );
  assert.ok(app.Config.Env.includes("QQ_ACCOUNT=234567890"));
  assert.deepEqual(
    wechat.Mounts.map((m) => [m.Source, m.Destination]),
    [[directory + "/koishi/data/agent-wechat", "/var/lib/yesimbot/data/agent-wechat"]],
  );
  assert.equal(wechat.Image, IMAGES["yesimbot-wechat:1"]);
  assert.equal(net.Image, IMAGES["yesimbot-wechat:1"]);
  // The firewall is in place before anything starts; NapCat and agent-wechat start once the app answers.
  const firstStart = index(mock.calls, "start");
  assert.ok(mock.calls.findIndex((call) => call[0] === "iptables" && call.includes("-I")) < firstStart);
  assert.ok(index(mock.calls, "start", names.app) < ready[0]);
  assert.ok(ready[0] <= index(mock.calls, "start", names.napcat));
  assert.ok(ready[0] <= index(mock.calls, "start", names.wechat));
});

test("without a QQ account there is no NapCat container", async (t) => {
  const { manager, mock } = fixture(t);
  manager.register(A, {});
  manager.start(A, {});
  await manager.drain();
  assert.equal(manager.records.get(A).state, "running");
  assert.equal(mock.containers.has(names.napcat), false);
  assert.ok(mock.containers.get(names.app).Config.Env.includes("QQ_ACCOUNT="));
});

test("a QQ crash restarts NapCat alone, and a new namespace restarts every part that joined the old one", async (t) => {
  const { manager, mock } = fixture(t);
  manager.register(A, { qqAccount: "234567890" });
  manager.start(A, {});
  await manager.drain();
  const before = Object.fromEntries(["net", "app", "wechat"].map((part) => [part, mock.containers.get(names[part]).State.StartedAt]));
  mock.containers.get(names.napcat).State = { Running: false, Status: "exited" };
  mock.calls.length = 0;
  await manager.monitor();
  await manager.drain();
  assert.equal(mock.containers.get(names.napcat).State.Running, true);
  for (const part of ["net", "app", "wechat"]) assert.equal(mock.containers.get(names[part]).State.StartedAt, before[part]);
  assert.ok(!mock.calls.some((call) => ["stop", "rm", "restart", "create"].includes(call[1])));

  mock.containers.get(names.net).State = { Running: false, Status: "exited" };
  await manager.monitor();
  await manager.drain();
  const net = mock.containers.get(names.net);
  for (const part of ["app", "napcat", "wechat"]) {
    const c = mock.containers.get(names[part]);
    assert.equal(c.State.Running, true);
    assert.ok(Date.parse(c.State.StartedAt) > Date.parse(net.State.StartedAt), part);
  }
  assert.equal(manager.records.get(A).state, "running");
});

test("a new app image replaces only a stopped app; QQ and WeChat keep the images they run", async (t) => {
  const { manager, mock, config } = fixture(t);
  manager.register(A, { qqAccount: "234567890" });
  manager.start(A, {});
  await manager.drain();
  const napcat = mock.containers.get(names.napcat).Id;
  manager.stop(A);
  await manager.drain();
  assert.ok(["net", "app", "napcat", "wechat"].every((part) => !mock.containers.get(names[part]).State.Running));
  manager.config.pod = { ...config.pod, app: "yesimbot-app:2" };
  manager.start(A, {});
  await manager.drain();
  assert.equal(manager.records.get(A).state, "running");
  assert.equal(mock.containers.get(names.app).Image, IMAGES["yesimbot-app:2"]);
  assert.equal(mock.containers.get(names.napcat).Id, napcat);
});

test("an app patched in place by a deploy survives the manager's restart on the new pin; QQ keeps running", async (t) => {
  const { manager, mock, config } = fixture(t);
  manager.register(A, { qqAccount: "234567890" });
  manager.start(A, {});
  await manager.drain();
  const ids = Object.fromEntries(["net", "app", "napcat", "wechat"].map((part) => [part, mock.containers.get(names[part]).Id]));
  // What deploy_preview_remote.py leaves: the pin moved on, the record names the image the app container came from.
  manager.config.pod = { ...config.pod, app: "yesimbot-app:2" };
  manager.records.get(A).patchedFrom = IMAGES["yesimbot-app:1"];
  const before = mock.calls.length;
  await manager.reconcile();
  await manager.drain();
  assert.equal(manager.records.get(A).state, "running");
  for (const part of Object.keys(ids)) assert.equal(mock.containers.get(names[part]).Id, ids[part], part);
  assert.equal(mock.calls.slice(before).filter((call) => ["stop", "rm", "restart", "create"].includes(call[1])).length, 0);
  assert.equal(manager.records.get(A).patchedFrom, IMAGES["yesimbot-app:1"]);
});

test("a part changed behind the manager's back is never started", async (t) => {
  const { manager, mock } = fixture(t);
  manager.register(A, { qqAccount: "234567890" });
  manager.start(A, {});
  await manager.drain();
  mock.containers.get(names.napcat).HostConfig.CapAdd.push("CAP_NET_ADMIN");
  mock.containers.get(names.napcat).State = { Running: false, Status: "exited" };
  await manager.monitor();
  await manager.drain();
  assert.equal(manager.records.get(A).state, "error");
  assert.equal(mock.containers.get(names.napcat).State.Running, false);
});

test("an account moves to the pod layout and back without touching its data", async (t) => {
  const { manager, mock, directory, root, config } = fixture(t);
  // Recorded before the pod images existed: the single container.
  const single = new RuntimeManager({ ...config, pod: undefined }, { run: mock.run, readinessAttempts: 1, retryDelay: 0 });
  single.cookie = async () => "private-cookie";
  single.register(A, { qqAccount: "234567890" });
  single.start(A, {});
  await single.drain();
  assert.equal(single.records.get(A).layout, undefined);
  assert.equal(mock.containers.get(names.app).Image, IMAGES.single);
  fs.writeFileSync(directory + "/qq/login.db", "kept");
  const moved = new RuntimeManager(config, { run: mock.run, readinessAttempts: 1, retryDelay: 0 });
  moved.cookie = async () => "private-cookie";
  moved.relayout(A, { layout: "pod" });
  await moved.drain();
  assert.equal(moved.records.get(A).layout, "pod");
  assert.equal(moved.records.get(A).state, "running");
  assert.equal(mock.containers.get(names.app).Image, IMAGES["yesimbot-app:1"]);
  assert.equal(mock.containers.get(names.napcat).State.Running, true);
  moved.relayout(A, { layout: "single" });
  await moved.drain();
  assert.equal(moved.records.get(A).layout, undefined);
  assert.equal(mock.containers.get(names.app).Image, IMAGES.single);
  for (const part of ["net", "napcat", "wechat"]) assert.equal(mock.containers.has(names[part]), false);
  assert.equal(fs.readFileSync(directory + "/qq/login.db", "utf8"), "kept");
  assert.equal(JSON.parse(fs.readFileSync(root + "/members/runtimes.json", "utf8")).runtimes[0].layout, undefined);
  await single.close?.();
});

test("ops show NapCat's own container and restart it alone", async (t) => {
  const { manager, mock } = fixture(t);
  manager.register(A, { qqAccount: "234567890" });
  manager.start(A, {});
  await manager.drain();
  const instance = await manager.opsMember(manager.records.get(A));
  assert.equal(instance.programs.koishi.state, "RUNNING");
  assert.equal(instance.programs.napcat.state, "RUNNING");
  assert.equal(instance.memory.usedBytes, 3 * 100 * 1024 * 1024);
  const app = mock.containers.get(names.app).State.StartedAt;
  mock.calls.length = 0;
  const responses = [];
  const res = { writeHead: () => {}, end: (body) => responses.push(JSON.parse(body)), once: () => {} };
  const req = Object.assign(require_body({ program: "napcat" }), {});
  await manager.restartOps(req, res, A);
  assert.ok(mock.calls.some((call) => call[1] === "restart" && call.at(-1) === names.napcat));
  assert.ok(!mock.calls.some((call) => call[1] === "exec" && call.includes("restart")));
  assert.equal(mock.containers.get(names.app).State.StartedAt, app);
  assert.equal(responses[0].instance.programs.napcat.state, "RUNNING");
});

test("deleting an account removes every part", async (t) => {
  const { manager, mock } = fixture(t);
  manager.register(A, { qqAccount: "234567890" });
  manager.start(A, {});
  await manager.drain();
  manager.remove(A);
  await manager.drain();
  for (const part of ["net", "app", "napcat", "wechat"]) assert.equal(mock.containers.has(names[part]), false);
  assert.equal(manager.records.has(A), false);
  assert.ok(
    mock.calls.findIndex((call) => call[1] === "rm" && call.at(-1) === names.net) >
      mock.calls.findIndex((call) => call[1] === "rm" && call.at(-1) === names.app),
  );
});

test("the pod images are all three or none", (t) => {
  const { config } = fixture(t);
  assert.throws(() => validateConfig({ ...config, pod: { app: "a", napcat: "b" } }));
  assert.throws(() => validateConfig({ ...config, pod: { app: "a", napcat: "b", wechat: "--privileged" } }));
  assert.throws(() => validateConfig({ ...config, pod: { app: "a", napcat: "b", wechat: "c", extra: "d" } }));
  assert.deepEqual(validateConfig(config).pod, config.pod);
});

/** A request whose JSON body the manager reads. */
function require_body(body) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  return {
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
    on(event, listener) {
      if (event === "data") for (const chunk of chunks) listener(chunk);
      if (event === "end") listener();
      return this;
    },
  };
}
