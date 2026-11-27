import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
const exec = promisify(execFile);
const bundle = resolve(process.env.YESIMBOT_DEVICE_BUNDLE_DIR ?? ".release-local/device-client/dist");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-portable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["client.cjs", "gateway.cjs", "migrate-state.cjs"]) await copyFile(join(bundle, name), join(root, name));
  return root;
}
test("device CLI rejects an untrusted gateway even when its parent disables TLS checks", async (t) => {
  const root = await fixture(t),
    key = join(root, "key.pem"),
    cert = join(root, "cert.pem");
  await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"]);
  let requests = 0;
  const server = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, (_req, res) => {
    requests++;
    res.writeHead(401).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const state = join(root, "state"),
    executable = join(root, "client.cjs");
  await exec(process.execPath, [executable, "init", "--state", state, "--gateway", `https://127.0.0.1:${server.address().port}`]);
  const result = await exec(process.execPath, [executable, "diagnose", "--state", state], {
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  });
  assert.equal(JSON.parse(result.stdout).find((entry) => entry.id === "gateway").ok, false);
  assert.equal(requests, 0);
});
test("relocated gateway and migration CLIs run without repository dependencies", async (t) => {
  const root = await fixture(t),
    state = join(root, "gateway"),
    output = join(root, "credential.json"),
    tenant = randomUUID();
  const command = [join(root, "gateway.cjs"), "ensure-runtime", "--state", state, "--tenant", tenant, "--output", output];
  await exec(process.execPath, command, { cwd: root });
  const original = await readFile(output, "utf8");
  await exec(process.execPath, command, { cwd: root });
  assert.equal(await readFile(output, "utf8"), original);
  await exec(process.execPath, [join(root, "gateway.cjs"), "revoke-runtime", "--state", state, "--tenant", tenant]);
  await assert.rejects(exec(process.execPath, command, { cwd: root }));
  const runtime = join(root, "runtime");
  await mkdir(join(runtime, "data/yesimbot"), { recursive: true });
  await writeFile(join(runtime, "data/yesimbot/runtime-identity.json"), JSON.stringify({ version: 1, tenantId: tenant }));
  await exec(process.execPath, [join(root, "migrate-state.cjs"), "inventory", "--root", runtime, "--output", join(root, "plan.json")], { cwd: root });
  assert.equal(JSON.parse(await readFile(join(root, "plan.json"), "utf8")).tenantId, tenant);
});
test("standalone device remains alive while offline, excludes a second process, and shuts down cleanly", async (t) => {
  const root = await fixture(t),
    state = join(root, "client-state");
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const gateway = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  await exec(process.execPath, [join(root, "client.cjs"), "init", "--state", state, "--gateway", gateway], { cwd: root });
  const path = join(state, "config.json"),
    config = JSON.parse(await readFile(path, "utf8"));
  config.allowLoopback = true;
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  await writeFile(join(state, "credential.json"), JSON.stringify({ version: 1, tenantId: randomUUID(), deviceId: randomUUID(), secret: "a".repeat(64) }), {
    mode: 0o600,
  });
  const child = spawn(process.execPath, [join(root, "client.cjs"), "run", "--state", state], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const closed = once(child, "close");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("client_did_not_attempt_connection")), 5000);
    child.stdout.on("data", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(child.exitCode, null);
  await assert.rejects(exec(process.execPath, [join(root, "client.cjs"), "run", "--state", state], { cwd: root }), (error) =>
    error.stderr.includes("device_client_already_running"),
  );
  child.kill("SIGTERM");
  assert.deepEqual(await closed, [0, null]);
});

test("relocated local settings reuse a single controller and quit without removing identity state", async (t) => {
  const root = await fixture(t),
    state = join(root, "ui-state"),
    executable = join(root, "client.cjs");
  const child = spawn(process.execPath, [executable, "ui", "--auto-start", "--state", state], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const closed = once(child, "close");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("ui_did_not_start")), 5000);
    child.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", reject);
  });
  const path = join(state, "control", "ui.json"),
    info = JSON.parse(await readFile(path, "utf8"));
  const snapshot = await fetch(info.origin + "/api/snapshot", { headers: { authorization: "Bearer " + info.token } });
  const { state: clientState, paired } = await snapshot.json();
  assert.deepEqual({ state: clientState, paired }, { state: "stopped", paired: false });
  const duplicate = await exec(process.execPath, [executable, "ui", "--state", state], { cwd: root });
  assert.match(duplicate.stdout, /已经运行/);
  assert.equal(await readFile(path, "utf8"), JSON.stringify(info, null, 2) + "\n");
  assert.ok(!duplicate.stdout.includes(info.token));
  await exec(process.execPath, [executable, "quit", "--state", state], { cwd: root });
  assert.deepEqual(await closed, [0, null]);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  // Repeated shutdown is harmless and does not need a pairing/configuration.
  await exec(process.execPath, [executable, "quit", "--state", state], { cwd: root });
});
