import { randomUUID, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineModuleConfig } from "@yesimbot/foundation";
import { defineExtension, type Extension } from "koishi-plugin-yesimbot/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { startServer, type RunningServer } from "../src/host.js";
import { EXTENSIONS } from "../src/registry.js";

const modelProvider = EXTENSIONS.find((extension) => extension.moduleConfig.id === "yesimbot-model-provider")!;

const roots: string[] = [];
const running: RunningServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** An extension with a secret field, recording each start with the config it got. */
function probe() {
  const starts: { token: string; every: number }[] = [];
  const extension = defineExtension({
    moduleConfig: defineModuleConfig(
      "yesimbot-probe",
      z.looseObject({ token: z.string().default("").meta({ title: "Token", secret: true }), every: z.number().int().min(1).default(1) }),
    ),
    start(ctx) {
      starts.push({ token: ctx.config.token, every: ctx.config.every });
    },
  });
  return { extension: extension as Extension, starts };
}

async function instance(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "host-console-"));
  roots.push(root);
  await mkdir(join(root, "config", "secrets"), { recursive: true, mode: 0o700 });
  const salt = Buffer.alloc(16, 7);
  await writeFile(
    join(root, "owner.json"),
    JSON.stringify({ version: 1, username: "owner", salt: salt.toString("base64"), hash: scryptSync("correct", salt, 64).toString("base64") }),
    { mode: 0o600 },
  );
  const files: Record<string, unknown> = {
    "app.json": { server: { host: "127.0.0.1", port: 0 } },
    "yesimbot.json": { enabled: true, config: { chatModel: "fake:main" } },
    // A model that resolves; nothing listens at its address, so a turn fails after the message is in.
    "yesimbot-model-provider.json": {
      enabled: true,
      config: {
        connections: [
          {
            type: "openai",
            id: "fake",
            apiKey: { $secret: "/connections/0/apiKey" },
            baseURL: "http://127.0.0.1:9/v1",
            format: "chat",
            chatModels: [{ id: "main", toolCall: true }],
            embeddingModels: [],
          },
        ],
      },
    },
    "secrets/yesimbot-model-provider.json": { "/connections/0/apiKey": "sk-test" },
    "yesimbot-console.json": { enabled: true, config: { admin: { enabled: true, credentialFile: "owner.json" }, webui: { enabled: true } } },
    "yesimbot-probe.json": { enabled: true, config: { token: { $secret: "/token" }, every: 1 } },
    "secrets/yesimbot-probe.json": { "/token": "sk-old" },
  };
  for (const [name, value] of Object.entries(files)) await writeFile(join(root, "config", name), JSON.stringify(value), { mode: 0o600 });
  return root;
}

/** The owner's browser: same-origin requests with the session cookie. */
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
    login: () => call("POST", "/yesimbot/admin/login", { username: "owner", password: "correct" }),
    read: async (path: string) =>
      (await call("GET", `/yesimbot/api/v1/plugins/config?path=${encodeURIComponent(path)}`)).body as { revision: string; config: Record<string, unknown> },
    update: (revision: string, path: string, config: unknown) => call("POST", "/yesimbot/api/v1/plugins/update", { revision, path, config }),
  };
}

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

describe("the console on the new host (leave-koishi 6.4)", () => {
  it("logs in, edits a module through config/ with its secret kept apart, and restarts only that module", async () => {
    const root = await instance();
    const { extension, starts } = probe();
    const server = await startServer({ stateDir: root, extensions: [extension] });
    running.push(server);
    expect(server.state("yesimbot-console")).toEqual({ state: "running" });
    const owner = browser(server);
    expect((await owner.call("GET", "/yesimbot/api/v1/plugins/config?path=yesimbot-probe")).status).toBe(401);
    expect((await owner.login()).status).toBe(200);

    const current = await owner.read("yesimbot-probe");
    // The form shows that a secret is set, never its value.
    expect(current.config).toEqual({ token: { $secret: true, sourcePath: ["token"] }, every: 1 });
    expect(JSON.stringify(current)).not.toContain("sk-old");

    const core = server.core;
    expect((await owner.update(current.revision, "yesimbot-probe", { ...current.config, every: 5 })).status).toBe(200);
    await server.idle();
    expect(starts).toEqual([
      { token: "sk-old", every: 1 },
      { token: "sk-old", every: 5 },
    ]);
    expect(server.core).toBe(core);
    expect(await readJson(join(root, "config", "yesimbot-probe.json"))).toEqual({ enabled: true, config: { token: { $secret: "/token" }, every: 5 } });

    const next = await owner.read("yesimbot-probe");
    expect((await owner.update(next.revision, "yesimbot-probe", { token: "sk-new", every: 5 })).status).toBe(200);
    await server.idle();
    expect(starts.at(-1)).toEqual({ token: "sk-new", every: 5 });
    const stored = await readFile(join(root, "config", "yesimbot-probe.json"), "utf8");
    expect(stored).not.toContain("sk-new");
    expect(await readJson(join(root, "config", "secrets", "yesimbot-probe.json"))).toEqual({ "/token": "sk-new" });
    expect((await stat(join(root, "config", "secrets", "yesimbot-probe.json"))).mode & 0o777).toBe(0o600);
    // Untouched modules keep their files as they were.
    expect(await readJson(join(root, "config", "yesimbot.json"))).toEqual({ enabled: true, config: { chatModel: "fake:main" } });
  });

  it("replaces Core on a Core edit and starts the modules again on it; the web chat goes on with the new Core", async () => {
    const root = await instance();
    const { extension, starts } = probe();
    const server = await startServer({ stateDir: root, extensions: [modelProvider, extension] });
    running.push(server);
    const owner = browser(server);
    await owner.login();
    const before = server.core;

    const core = await owner.read("yesimbot");
    expect((await owner.update(core.revision, "yesimbot", { ...core.config, modelRetries: 2 })).status).toBe(200);
    await server.idle();
    expect(server.core).not.toBe(before);
    expect(server.core.config.modelRetries).toBe(2);
    expect(server.state("yesimbot")).toEqual({ state: "running" });
    expect(starts).toHaveLength(2);
    expect((await readJson(join(root, "config", "yesimbot.json"))).config).toMatchObject({ chatModel: "fake:main", modelRetries: 2 });

    // The web chat is an account of the new Core only.
    expect(server.accounts.list().map((account) => `${account.platform}:${account.selfId}`)).toEqual(["web:bot"]);
    const clientId = randomUUID();
    const sent = await owner.call("POST", "/yesimbot/api/v1/chat/send", { text: "你好", clientId });
    expect(sent.status).toBe(202);
    await vi.waitFor(async () => {
      const chat = (await owner.call("GET", "/yesimbot/api/v1/chat")).body as { messages: { id: string; text: string; status?: string }[] };
      expect(chat.messages).toContainEqual(expect.objectContaining({ id: clientId, text: "你好", status: "sent" }));
    });
    // Core keeps the conversation in the instance directory, whatever the working directory is.
    expect(existsSync(join(root, "data", "yesimbot", "channels", "direct-web-owner-bot", "channel.json"))).toBe(true);
  });
});
