import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { readPluginPolicy } from "../src/plugin-policy.js";
import { OPTIONAL_MEMBER_PLUGIN_NAMES, normalizeMemberPlugins, pluginBaseName } from "../src/shared/plugin-catalog.js";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function policy(plugins: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "yesimbot-policy-"));
  directories.push(dir);
  const file = join(dir, "plugins.json");
  await writeFile(file, JSON.stringify({ version: 1, plugins }));
  return file;
}

it("keeps catalog names normalized and rejects unknown grants", () => {
  expect(pluginBaseName("~koishi-plugin-yesimbot-memorizer:abc")).toBe("yesimbot-memorizer");
  expect(pluginBaseName("@koishijs/plugin-console")).toBe("console");
  expect(normalizeMemberPlugins(["yesimbot-xiaoheihe", "yesimbot-memorizer", "yesimbot-memorizer"])).toEqual(["yesimbot-memorizer", "yesimbot-xiaoheihe"]);
  expect(() => normalizeMemberPlugins(["yesimbot-console"])).toThrow("invalid_plugins");
  expect(() => normalizeMemberPlugins(["yesimbot-quota"])).toThrow("invalid_plugins");
  expect(() => normalizeMemberPlugins(["yesimbot-chat-learning"])).toThrow("invalid_plugins");
  expect(() => normalizeMemberPlugins(["yesimbot-command-bridge"])).toThrow("invalid_plugins");
  expect(() => normalizeMemberPlugins("yesimbot-memorizer")).toThrow("invalid_plugins");
  expect(OPTIONAL_MEMBER_PLUGIN_NAMES).toContain("yesimbot-workspace");
});

it("fails closed to required plugins when the policy is missing or invalid", async () => {
  const warn = vi.fn();
  const missing = readPluginPolicy("/nonexistent/plugins.json", warn);
  expect(missing.has("yesimbot")).toBe(true);
  expect(missing.has("yesimbot-memorizer")).toBe(false);
  expect(warn).toHaveBeenCalledOnce();
  expect(readPluginPolicy(await policy(["evil"])).has("yesimbot-memorizer")).toBe(false);
  expect(readPluginPolicy(await policy(["yesimbot-memorizer"])).has("yesimbot-memorizer")).toBe(true);
});

it("grants nothing when the policy names a plugin that does not exist", async () => {
  const warn = vi.fn();
  const allowed = readPluginPolicy(await policy(["yesimbot-memorizer", "yesimbot-global-brain", "yesimbot-roleplay"]), warn);
  expect(warn).toHaveBeenCalledOnce();
  expect(allowed.has("yesimbot-memorizer")).toBe(false);
  expect(allowed.has("yesimbot-roleplay")).toBe(false);
});
