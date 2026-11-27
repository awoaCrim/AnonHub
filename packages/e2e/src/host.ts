import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FakeModel } from "./fake-model.js";

export const ADMIN = { username: "owner", password: "e2e-owner-password" } as const;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BOOT_TIMEOUT_MS = 90_000;

/**
 * What a scenario asks of the host, in host-neutral terms; the driver turns it into the host's `config/`.
 */
export interface HostOptions {
  readonly model: FakeModel;
  /** Channels the bot may hear; anything else is denied. */
  readonly allowedChannels: ReadonlyArray<{ platform: string; channelId: string; isDirect?: boolean }>;
  /** QQ through NapCat (OneBot v11, NapCat dials in over WebSocket). */
  readonly qq?: { readonly account: string };
  /** The chat model takes pictures as input. */
  readonly vision?: boolean;
  /** Files to put in the state directory before the host starts (path relative to it; objects are written as JSON), mode 0600. */
  readonly files?: Readonly<Record<string, string | object>>;
  /** Main-model input size (tokens, at least 8000) at which the conversation history is summarized in the background. */
  readonly contextTriggerTokens?: number;
  /** Debug logging, for investigating a failing scenario. */
  readonly debug?: boolean;
  /** Extensions to turn on, by module ID, with their settings (`config/<module>.json`). */
  readonly modules?: Readonly<Record<string, Record<string, unknown>>>;
  /** WeChat through the agent-wechat daemon. */
  readonly wechat?: {
    readonly endpoint: string;
    readonly token: string;
    readonly account: string;
    readonly rooms?: readonly string[];
    readonly peers?: readonly string[];
    /** Off unless set, as in production. */
    readonly autoReply?: { readonly direct?: boolean; readonly group?: boolean };
  };
}

export interface Host {
  /** http://127.0.0.1:<port> */
  readonly url: string;
  readonly stateDir: string;
  /** The OneBot WebSocket URL NapCat dials, when QQ is on. */
  readonly onebotUrl?: string;
  readonly admin: { readonly username: string; readonly password: string };
  /** Process output so far, for failure messages. */
  output(): string;
  stop(): Promise<void>;
}

/** Starts the host (`apps/server`) in a fresh state directory, the way its container does. */
export async function startHost(options: HostOptions): Promise<Host> {
  return startServerHost(options);
}

/** Polls `check` until it is true; the failure message carries `detail()`. */
export async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs = 20_000, detail: () => string = () => ""): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms\n${detail().slice(-4000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * `apps/server` with `config/` as production has it: one file per module, the API key and the OneBot path in
 * `config/secrets/`, the daemon's token in its own file.
 */
async function startServerHost(options: HostOptions): Promise<Host> {
  const stateDir = await mkdtemp(join(tmpdir(), "yesimbot-e2e-server-"));
  const port = await freePort();
  const onebotPath = `/onebot/${randomBytes(32).toString("hex")}`;
  await writeCredential(join(stateDir, "data/console-admin/credential.json"));
  if (options.wechat) {
    await mkdir(join(stateDir, "data/agent-wechat"), { recursive: true, mode: 0o700 });
    await writeFile(join(stateDir, "data/agent-wechat/api-token"), options.wechat.token + "\n", { mode: 0o600 });
  }
  for (const [path, content] of Object.entries(options.files ?? {})) {
    await mkdir(dirname(join(stateDir, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(stateDir, path), typeof content === "string" ? content : JSON.stringify(content, null, 2), { mode: 0o600 });
  }
  const config = join(stateDir, "config");
  await mkdir(join(config, "secrets"), { recursive: true, mode: 0o700 });
  const files: Record<string, unknown> = {
    "app.json": { server: { host: "127.0.0.1", port }, ...(options.debug ? { log: { level: 3 } } : {}) },
    "yesimbot.json": {
      enabled: true,
      config: {
        allowedChannels: options.allowedChannels,
        chatModel: "fake:main",
        ...(options.vision ? { visionModel: "fake:main" } : {}),
        ...(options.contextTriggerTokens ? { session: { magicContext: { triggerTokens: options.contextTriggerTokens } } } : {}),
      },
    },
    "yesimbot-console.json": {
      enabled: true,
      config: {
        webui: { enabled: true },
        admin: { enabled: true, credentialFile: "data/console-admin/credential.json", sessionHours: 1 },
        napcat: { enabled: false },
        wechat: { enabled: !!options.wechat },
      },
    },
    "yesimbot-model-provider.json": {
      enabled: true,
      config: {
        connections: [
          {
            type: "openai",
            id: "fake",
            apiKey: { $secret: "/connections/0/apiKey" },
            baseURL: options.model.url,
            format: "chat",
            chatModels: [{ id: "main", toolCall: true, reasoning: false }],
            embeddingModels: [],
          },
        ],
      },
    },
    "secrets/yesimbot-model-provider.json": { "/connections/0/apiKey": "sk-e2e-not-a-real-key" },
    ...(options.qq
      ? {
          "adapter-onebot.json": { enabled: true, config: { selfId: options.qq.account, protocol: "ws-reverse", path: { $secret: "/path" } } },
          "secrets/adapter-onebot.json": { "/path": onebotPath },
        }
      : {}),
    ...(options.wechat
      ? {
          "adapter-wechat-bridge.json": {
            enabled: true,
            config: {
              endpoint: options.wechat.endpoint,
              tokenFile: "data/agent-wechat/api-token",
              account: options.wechat.account,
              allowedRooms: [...(options.wechat.rooms ?? [])],
              allowedPeers: [...(options.wechat.peers ?? [])],
              autoReply: { direct: options.wechat.autoReply?.direct ?? false, group: options.wechat.autoReply?.group ?? false },
            },
          },
        }
      : {}),
    ...Object.fromEntries(Object.entries(options.modules ?? {}).map(([id, config]) => [`${id}.json`, { enabled: true, config }])),
  };
  for (const [name, value] of Object.entries(files)) await writeFile(join(config, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  const child = spawn(process.execPath, [join(REPO, "apps/server/dist/main.js"), "--state", stateDir], {
    cwd: stateDir,
    env: { ...process.env, YESIMBOT_NETWORK_FILE: join(stateDir, "data/network.json") },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  return boot(child, stateDir, `http://127.0.0.1:${port}`, options.qq ? `ws://127.0.0.1:${port}${onebotPath}` : undefined);
}

/** Waits until the console answers; a host that never does is stopped and its output reported. */
async function boot(child: ChildProcess, stateDir: string, url: string, onebotUrl?: string): Promise<Host> {
  let output = "";
  child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const host: Host = {
    url,
    stateDir,
    ...(onebotUrl ? { onebotUrl } : {}),
    admin: ADMIN,
    output: () => output,
    stop: async () => {
      await stopProcess(child);
      await rm(stateDir, { recursive: true, force: true });
    },
  };
  try {
    await waitUntil(
      async () => (await fetch(`${url}/yesimbot/admin/session`).catch(() => undefined))?.ok === true,
      BOOT_TIMEOUT_MS,
      () => output,
    );
  } catch (error) {
    await host.stop();
    throw error;
  }
  return host;
}

async function writeCredential(path: string): Promise<void> {
  const salt = randomBytes(16);
  const hash = scryptSync(ADMIN.password, salt, 64);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ version: 1, username: ADMIN.username, salt: salt.toString("base64"), hash: hash.toString("base64") }), {
    mode: 0o600,
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    // Signal the whole group, so nothing the host started outlives it.
    process.kill(-child.pid!, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 10_000);
  await exited;
  clearTimeout(timer);
}
