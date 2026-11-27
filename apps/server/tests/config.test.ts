import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadHostConfig } from "../src/config.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function state(files: Record<string, unknown>, secrets: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "host-config-"));
  roots.push(root);
  await mkdir(join(root, "config/secrets"), { recursive: true, mode: 0o700 });
  for (const [name, value] of Object.entries(files))
    await writeFile(join(root, "config", name), typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  for (const [name, value] of Object.entries(secrets)) await writeFile(join(root, "config/secrets", name), JSON.stringify(value), { mode: 0o600 });
  return root;
}

describe("reading config/ (convention 02)", () => {
  it("fills app defaults and puts each module's secrets back in place", async () => {
    const root = await state(
      {
        "yesimbot.json": { enabled: true, config: { chatModel: "main:m" } },
        "yesimbot-model-provider.json": { enabled: true, config: { connections: [{ id: "main", apiKey: { $secret: "/connections/0/apiKey" } }] } },
        "yesimbot-memorizer.json": { enabled: false, config: {} },
        "notes.txt": "not a module",
      },
      { "yesimbot-model-provider.json": { "/connections/0/apiKey": "sk-1" } },
    );
    const config = await loadHostConfig(root);
    expect(config.app).toEqual({ server: { host: "127.0.0.1", port: 5140 }, log: {} });
    expect([...config.modules.keys()]).toEqual(["yesimbot-memorizer", "yesimbot-model-provider", "yesimbot"]);
    expect(config.modules.get("yesimbot-model-provider")).toEqual({ enabled: true, config: { connections: [{ id: "main", apiKey: "sk-1" }] } });
    expect(config.modules.get("yesimbot-memorizer")?.enabled).toBe(false);
  });

  it("reads app.json as written by the split", async () => {
    const root = await state({ "app.json": { server: { host: "0.0.0.0", port: 5140, selfUrl: "http://x" }, log: { level: 3 } } });
    expect((await loadHostConfig(root)).app).toEqual({ server: { host: "0.0.0.0", port: 5140, selfUrl: "http://x" }, log: { level: 3 } });
  });

  it("refuses what it cannot use, rewriting nothing", async () => {
    await expect(loadHostConfig(join(tmpdir(), "host-config-none-" + process.pid))).rejects.toMatchObject({ code: "host_config_missing" });
    const missing = await state({ "yesimbot-search-service.json": { enabled: true, config: { tavily: { apiKey: { $secret: "/tavily/apiKey" } } } } });
    await expect(loadHostConfig(missing)).rejects.toMatchObject({ code: "config_secret_missing", detail: "yesimbot-search-service: /tavily/apiKey" });
    await expect(loadHostConfig(await state({ "yesimbot.json": { chatModel: "main:m" } }))).rejects.toMatchObject({ code: "host_config_unreadable" });
    await expect(loadHostConfig(await state({ "yesimbot.json": "{" }))).rejects.toMatchObject({ code: "host_config_unreadable" });
    await expect(loadHostConfig(await state({ "app.json": { server: { port: "x" } } }))).rejects.toMatchObject({ code: "config_invalid" });
  });

  it("reads secrets only from a file closed to others", async () => {
    const root = await state(
      { "yesimbot-search-service.json": { enabled: true, config: { tavily: { apiKey: { $secret: "/tavily/apiKey" } } } } },
      { "yesimbot-search-service.json": { "/tavily/apiKey": "tvly-1" } },
    );
    await chmod(join(root, "config/secrets/yesimbot-search-service.json"), 0o644);
    await expect(loadHostConfig(root)).rejects.toMatchObject({ code: "file_not_private" });
  });
});
