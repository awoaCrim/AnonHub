import { scryptSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineModuleConfig } from "@yesimbot/foundation";
import { contextPolicy } from "koishi-plugin-yesimbot-console/server";
import { defineExtension, type Extension } from "koishi-plugin-yesimbot/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { startServer, type RunningServer } from "../src/host.js";

const TENANT = "4b0b0c9e-5c43-4f6a-9d3e-0a1b2c3d4e5f";
const roots: string[] = [];
const running: RunningServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** An optional catalog module that records whether it runs. */
function probe(id: string) {
  const runs = { starts: 0, stops: 0 };
  const extension = defineExtension({
    moduleConfig: defineModuleConfig(id, z.looseObject({ note: z.string().default("") })),
    start() {
      runs.starts++;
      return () => void runs.stops++;
    },
  });
  return { extension: extension as Extension, runs };
}

const policy = (session: Record<string, unknown> = {}) => JSON.stringify(contextPolicy(session)) + "\n";

/** A member runtime's state: its config, its admin login, and the account manager's read-only policy beside it. */
async function member(granted: string[]) {
  const root = await mkdtemp(join(tmpdir(), "host-member-"));
  roots.push(root);
  await mkdir(join(root, "config", "secrets"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "policy"), { mode: 0o700 });
  const salt = Buffer.alloc(16, 7);
  await writeFile(
    join(root, "admin.json"),
    JSON.stringify({ version: 1, username: "admin", salt: salt.toString("base64"), hash: scryptSync("correct", salt, 64).toString("base64") }),
  );
  const files: Record<string, unknown> = {
    "app.json": { server: { host: "127.0.0.1", port: 0 } },
    "yesimbot.json": { enabled: true, config: {} },
    "yesimbot-console.json": { enabled: true, config: { admin: { enabled: true, credentialFile: "admin.json" }, webui: { enabled: true } } },
    "yesimbot-usage.json": { enabled: true, config: { note: "granted" } },
    "yesimbot-xiaoheihe.json": { enabled: true, config: { note: "kept" } },
  };
  for (const [name, value] of Object.entries(files)) await writeFile(join(root, "config", name), JSON.stringify(value));
  await writeFile(join(root, "policy", "plugins.json"), JSON.stringify({ version: 1, plugins: granted }));
  await writeFile(join(root, "policy", "context.json"), policy({ magicContext: { triggerTokens: 50_000 } }));
  vi.stubEnv("YESIMBOT_TENANT_ID", TENANT);
  const granted_ = probe("yesimbot-usage");
  const refused = probe("yesimbot-xiaoheihe");
  const server = await startServer({
    stateDir: root,
    env: { YESIMBOT_TENANT_ID: TENANT },
    extensions: [granted_.extension, refused.extension],
    policyFiles: { plugins: join(root, "policy", "plugins.json"), context: join(root, "policy", "context.json"), intervalMs: 50 },
  });
  running.push(server);
  return { root, server, granted: granted_.runs, refused: refused.runs };
}

function browser(server: RunningServer) {
  const origin = `http://127.0.0.1:${server.http.port}`;
  let cookie = "";
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(origin + path, {
      method,
      headers: { origin, cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";", 1)[0]!;
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
  };
  return {
    call,
    login: () => call("POST", "/yesimbot/admin/login", { username: "admin", password: "correct" }),
    read: async (path: string) =>
      (await call("GET", `/yesimbot/api/v1/plugins/config?path=${encodeURIComponent(path)}`)).body as { revision: string; config: Record<string, unknown> },
    update: (revision: string, path: string, config: unknown) => call("POST", "/yesimbot/api/v1/plugins/update", { revision, path, config }),
  };
}

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as { enabled: boolean; config: Record<string, unknown> };

describe("a member runtime on the new host follows the account manager's policy", () => {
  it("runs only granted modules, turns the others off in config/ and keeps their settings", async () => {
    const { root, server, granted, refused } = await member(["yesimbot-usage"]);
    expect(server.state("yesimbot-console")).toEqual({ state: "running" });
    expect(granted.starts).toBe(1);
    expect(refused.starts).toBe(0);
    await vi.waitFor(async () => expect(await readJson(join(root, "config", "yesimbot-xiaoheihe.json"))).toEqual({ enabled: false, config: { note: "kept" } }));
    expect(await readJson(join(root, "config", "yesimbot-usage.json"))).toEqual({ enabled: true, config: { note: "granted" } });
  });

  it("gives Core the policy's session; the member edits the rest of Core but not that", async () => {
    const { root, server } = await member([]);
    expect(server.core.config.session).toMatchObject({ magicContext: { triggerTokens: 50_000 } });
    await vi.waitFor(async () =>
      expect((await readJson(join(root, "config", "yesimbot.json"))).config.session).toMatchObject({ magicContext: { triggerTokens: 50_000 } }),
    );
    const admin = browser(server);
    expect((await admin.login()).status).toBe(200);
    const core = await admin.read("yesimbot");
    expect((await admin.update(core.revision, "yesimbot", { ...core.config, modelRetries: 2 })).status).toBe(200);
    await server.idle();
    expect(server.core.config.modelRetries).toBe(2);
    expect(server.core.config.session).toMatchObject({ magicContext: { triggerTokens: 50_000 } });
    const next = await admin.read("yesimbot");
    const session = { ...(next.config.session as Record<string, unknown>), magicContext: { triggerTokens: 20_000 } };
    expect(await admin.update(next.revision, "yesimbot", { ...next.config, session })).toMatchObject({
      status: 403,
      body: { message: "locked", path: "session" },
    });
  });

  it("refuses to start a module the policy does not grant, or to change its own console", async () => {
    const { root, server, refused } = await member([]);
    await vi.waitFor(async () => expect((await readJson(join(root, "config", "yesimbot-xiaoheihe.json"))).enabled).toBe(false));
    const admin = browser(server);
    await admin.login();
    const consoleBefore = await readFile(join(root, "config", "yesimbot-console.json"), "utf8");
    const own = await admin.read("yesimbot-console");
    expect((await admin.update(own.revision, "yesimbot-console", { ...own.config, webui: { enabled: false } })).status).not.toBe(200);
    expect(await readFile(join(root, "config", "yesimbot-console.json"), "utf8")).toBe(consoleBefore);
    expect(server.state("yesimbot-console")).toEqual({ state: "running" });
    expect(refused.starts).toBe(0);
  });

  it("stops a revoked module and replaces Core when the session policy changes", async () => {
    const { root, server, granted } = await member(["yesimbot-usage"]);
    const before = server.core;
    await writeFile(join(root, "policy", "plugins.json"), JSON.stringify({ version: 1, plugins: [] }));
    await vi.waitFor(async () => expect((await readJson(join(root, "config", "yesimbot-usage.json"))).enabled).toBe(false));
    await server.idle();
    expect(granted.stops).toBe(1);
    expect(server.state("yesimbot-usage")).toMatchObject({ state: "disabled" });
    await writeFile(join(root, "policy", "context.json"), policy({}));
    await vi.waitFor(() => expect(server.core).not.toBe(before));
    await server.idle();
    expect(server.core.config.session).toMatchObject(contextPolicy({}).session);
  });
});

describe("an owner with account management on the new host", () => {
  it("publishes its effective session settings for the account manager", async () => {
    const root = await mkdtemp(join(tmpdir(), "host-owner-"));
    roots.push(root);
    await mkdir(join(root, "config"), { recursive: true });
    const salt = Buffer.alloc(16, 7);
    await writeFile(
      join(root, "admin.json"),
      JSON.stringify({ version: 1, username: "admin", salt: salt.toString("base64"), hash: scryptSync("x", salt, 64).toString("base64") }),
    );
    await writeFile(join(root, "config", "app.json"), JSON.stringify({ server: { host: "127.0.0.1", port: 0 } }));
    await writeFile(join(root, "config", "yesimbot.json"), JSON.stringify({ enabled: true, config: { session: { magicContext: { triggerTokens: 60_000 } } } }));
    await writeFile(
      join(root, "config", "yesimbot-console.json"),
      JSON.stringify({
        enabled: true,
        config: { admin: { enabled: true, credentialFile: "admin.json" }, accounts: { enabled: true, managerEndpoint: "http://127.0.0.1:9" } },
      }),
    );
    const server = await startServer({ stateDir: root, extensions: [] });
    running.push(server);
    expect(server.state("yesimbot-console")).toEqual({ state: "running" });
    const file = join(root, "data", "console-admin", "context-policy.json");
    await vi.waitFor(async () => expect(await readFile(file, "utf8")).toBe(JSON.stringify(contextPolicy(server.core.config.session)) + "\n"));
  });
});
