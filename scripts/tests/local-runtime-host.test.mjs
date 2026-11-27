import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalRuntimeHost } from "../local-runtime-host.mjs";

async function port() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "local-host-")),
    app = join(root, "app"),
    id = randomUUID();
  await mkdir(join(app, "data", "yesimbot"), { recursive: true });
  await writeFile(join(app, "data", "yesimbot", "runtime-identity.json"), JSON.stringify({ version: 1, tenantId: id }), { mode: 0o600 });
  const definition = await readFile(new URL("../../plugins/console/src/shared/context-policy.json", import.meta.url), "utf8");
  await writeFile(join(root, "context-policy.json"), definition);
  const defaults = (shape) =>
    Object.fromEntries(
      Object.entries(shape).flatMap(([key, rule]) => (Array.isArray(rule) ? (rule[1] === null ? [] : [[key, rule[1]]]) : [[key, defaults(rule)]])),
    );
  const policy = { version: 1, session: defaults(JSON.parse(definition)) };
  const config = {
    version: 1,
    id,
    token: "a".repeat(64),
    node: process.execPath,
    entry: join(root, "entry.cjs"),
    appRoot: app,
    stateRoot: root,
    port: await port(),
    backendPort: await port(),
  };
  await writeFile(
    config.entry,
    `const server=require('node:http').createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ready:true,instanceId:process.env.YESIMBOT_LOCAL_INSTANCE_ID}))});server.listen(${config.backendPort},'127.0.0.1');process.on('message',m=>{if(m.type==='exit')server.close(()=>process.exit(0))});process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`,
  );
  const host = new LocalRuntimeHost(config);
  await host.listen();
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  return { host, config, policy, root };
}
test("local supervisor requires its own token and rejects browser-origin requests", async (t) => {
  const { host, config } = await setup(t);
  const url = `http://127.0.0.1:${config.port}/runtime`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${config.token}`, origin: "http://untrusted.invalid" } })).status, 401);
  const result = await fetch(url, { headers: { authorization: `Bearer ${config.token}` } });
  assert.equal((await result.json()).runtime.id, host.config.id);
  assert.throws(() => new LocalRuntimeHost({ ...config, entry: "relative.cjs" }), /invalid_local_host_config/);
});
test("policy validation, supervised start/stop and persisted pause work without a model or chat connector", async (t) => {
  const { host, policy, root } = await setup(t);
  await assert.rejects(host.applyPolicy({ ...policy, session: { ...policy.session, token: "unexpected" } }), /invalid_context_policy/);
  await host.applyPolicy(policy);
  assert.deepEqual(JSON.parse(await readFile(join(root, "policy", "context.json"), "utf8")), policy);
  const old = structuredClone(policy);
  old.session.compact = { mode: "compartment" };
  await assert.rejects(host.applyPolicy(old), /invalid_context_policy/);
  await host.setDesired(true);
  await host.queue;
  assert.equal(host.state, "running");
  await host.setDesired(false);
  await host.queue;
  assert.equal(host.state, "stopped");
  assert.equal(JSON.parse(await readFile(join(root, "desired.json"), "utf8")).running, false);
  assert.equal(host.child, undefined);
});
