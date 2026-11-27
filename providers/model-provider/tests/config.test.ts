import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configForm, parseConfig } from "@yesimbot/foundation";
import { afterEach, describe, expect, it } from "vitest";

import { ModelService } from "../../../core/src/models/index.js";
import { extension, moduleConfig } from "../src/index.js";

const temporaryDirectories: string[] = [];
/** The parsed config of a raw one, as the host hands it to the module and the module parses it. */
const Config = (raw: unknown) => parseConfig(moduleConfig, raw) as never as Record<string, never>;
/** The parsed settings of one connection. */
const One = (raw: unknown) => (Config({ connections: [raw] }) as never as { connections: Record<string, never>[] }).connections[0]!;
/** A parsed config of one connection, as the host hands it to the module. */
const Only = (raw: unknown) => Config({ connections: [raw] });
const types = ["openai", "anthropic", "google", "deepseek"] as const;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function createRegistry(overrides: unknown = {}) {
  const directory = await mkdtemp(join(tmpdir(), "yesimbot-provider-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "models.json"), JSON.stringify(overrides));
  const service = new ModelService({ baseDir: directory, emit: () => undefined }, { basePath: directory });
  await service.start();
  return service;
}

function install(service: ModelService, raw: unknown) {
  // Parsing is what the host does when it loads the module: it throws before anything starts.
  const config = extension.parse(raw);
  let undo: (() => unknown) | void;
  return {
    ready: () => {
      undo = extension.start({ config, core: { model: service } } as never);
    },
    dispose: () => undo?.(),
  };
}

describe("unified Provider configuration", () => {
  it("defaults to the existing OpenAI configuration", () => {
    expect(One({ apiKey: "test" })).toMatchObject({
      type: "openai",
      id: "openai",
      format: "chat",
      imageToolResultPlacement: "tool-output",
      embeddingModels: [{ id: "text-embedding-3-small" }, { id: "text-embedding-3-large" }],
    });
  });

  it.each([
    ["openai", "gpt-4o"],
    ["anthropic", "claude-opus-4-6"],
    ["google", "gemini-2.5-flash"],
    ["deepseek", "deepseek-v4-flash"],
  ] as const)("preserves the %s branch defaults without wrapper keys", (type, firstModel) => {
    const config = One({ type, apiKey: "test" });
    expect(config.id).toBe(type);
    expect(config.chatModels[0]?.id).toBe(firstModel);
    expect(config.chatModels[0]).toMatchObject({ toolCall: true, reasoning: true });
    expect(config).not.toHaveProperty("connection");
    expect(config).not.toHaveProperty("options");
    expect(config).not.toHaveProperty("providers");
    if (type === "google") {
      expect(config).toMatchObject({ imageToolResultMediaTypes: ["image/png", "image/jpeg"], embeddingModels: [] });
      expect(config).not.toHaveProperty("videoToolResultSupport");
    }
    if (type === "deepseek") expect(config).toHaveProperty("thinking", "high");
  });

  it.each(types)("preserves explicit IDs, empty model lists, endpoints and operator metadata for %s", (type) => {
    const input = {
      type,
      id: "custom",
      apiKey: "test",
      baseURL: "https://fixture.invalid/v1",
      chatModels: [],
      $label: "custom label",
      $filter: { channelId: "room" },
    };
    expect(One(input)).toMatchObject(input);
  });

  it("rejects unsupported types and missing credentials", () => {
    expect(() => One({ type: "other", apiKey: "test" })).toThrow();
    expect(() => One({ type: "google" })).toThrow();
  });

  it.each(types)("retains registration timing, effective model IDs, capabilities and disposal for %s", async (type) => {
    const service = await createRegistry({ aliases: { main: "custom:model" }, chat: { "custom:model": { thinkingLevel: "off" } } });
    const config = Only({ type, id: "custom", apiKey: "test", chatModels: [{ id: "model", reasoning: true }] });
    const scope = install(service, config);
    expect(service.listProviders()).toEqual([]);
    scope.ready();
    const model = service.resolveChatModel("main");
    expect(model.fullId).toBe("custom:model");
    expect(model.entry.thinkingLevel).toBe("off");
    expect(model.capabilities.imageToolResult).toBe(type === "deepseek" ? "unknown" : "native");
    if (type === "google") expect(model.capabilities).toMatchObject({ videoInput: "native", historyProjection: "gemini-native" });
    scope.dispose();
    expect(service.listProviders()).toEqual([]);
    expect(() => service.resolveChatModel("main")).toThrow();
  });

  it("validates collections and preserves disabled opaque options", () => {
    const disabled = { enabled: false, apiKey: "retained", custom: { nested: [1, 2] }, thinking: "opaque" };
    const config = Config({ connections: [{ type: "google", id: "gemini", apiKey: "test" }, disabled] });
    expect(config).toMatchObject({ connections: [{ enabled: true, type: "google", id: "gemini" }, disabled] });
    expect(Config({ connections: [] })).toEqual({ connections: [] });
    expect(Config({ apiKey: "stale", type: "openai", connections: [{ type: "google", apiKey: "current" }] })).toMatchObject({
      connections: [{ type: "google", enabled: true, apiKey: "current" }],
    });
  });

  it("exposes a list of connections with a boolean switch and preserves settings through toggles", () => {
    const form = JSON.stringify(configForm(moduleConfig.schema));
    expect(form).toContain('"connections"');
    expect(form).toContain('"enabled":{"type":"boolean"');
    const active = { enabled: true, type: "openai", id: "line", apiKey: "retained", format: "responses", webSearch: true, custom: { value: 1 } };
    const toggle = (connection: unknown) => (Config({ connections: [connection] }) as { connections: unknown[] }).connections[0];
    const disabled = toggle({ ...active, enabled: false });
    expect(disabled).toEqual({ ...active, enabled: false });
    expect(toggle({ ...(disabled as object), enabled: true })).toMatchObject(active);
  });

  it.each([
    { connections: [{ type: "google" }] },
    { connections: [{ enabled: true, type: "google" }] },
    { connections: [{ type: "invalid", apiKey: "test" }] },
    { connections: [{ enabled: "false", type: "google", apiKey: "test" }] },
    { connections: "invalid" },
    { connections: null },
    { connections: {} },
    { apiKey: "single-key", type: "openai" },
  ])("rejects incomplete or invalid enabled collections", (input) => {
    expect(() => Config(input)).toThrow();
  });

  it("registers mixed native protocols in one instance and disposes only its own providers", async () => {
    const service = await createRegistry();
    const other = install(service, Only({ type: "openai", id: "other", apiKey: "test" }));
    other.ready();
    const scope = install(
      service,
      Config({
        connections: [
          ...types.map((type) => ({ type, id: type, apiKey: "test", chatModels: [{ id: "model", reasoning: true }] })),
          { enabled: false, id: "google", type: "google" },
          { enabled: false },
        ],
      }),
    );
    expect(service.listProviders()).toEqual(["other"]);
    scope.ready();
    expect(service.listProviders().sort()).toEqual(["other", ...types].sort());
    expect(service.resolveChatModel("google:model").capabilities.videoInput).toBe("native");
    expect(service.resolveChatModel("anthropic:model").capabilities.imageToolResult).toBe("native");
    scope.dispose();
    expect(service.listProviders()).toEqual(["other"]);
    // Reloading the same configuration must release and reclaim every ID.
    const reloaded = install(service, Config({ connections: [{ type: "google", apiKey: "test" }] }));
    reloaded.ready();
    expect(service.listProviders()).toEqual(["other", "google"]);
    reloaded.dispose();
    other.dispose();
    expect(service.listProviders()).toEqual([]);
  });

  it.each(["", "   "])("rejects empty active ID %j before installing any connection", async (id) => {
    const service = await createRegistry();
    expect(() =>
      install(
        service,
        Config({
          connections: [
            { type: "deepseek", id: "first", apiKey: "test" },
            { type: "openai", id, apiKey: "test" },
          ],
        }),
      ),
    ).toThrow("model_provider_id_missing");
    expect(service.listProviders()).toEqual([]);
  });

  it("rejects duplicate active IDs before synchronous native registration, without leaking secrets", async () => {
    const service = await createRegistry();
    expect(() =>
      install(
        service,
        Config({
          connections: [
            { type: "deepseek", id: "same", apiKey: "secret-one" },
            { type: "openai", id: "same", apiKey: "secret-two" },
          ],
        }),
      ),
    ).toThrow("model_provider_id_duplicate");
    expect(service.listProviders()).toEqual([]);
    expect(() => install(service, { connections: [{ type: "invalid", apiKey: "SECRET" }] } as never)).toThrow("model_provider_config_invalid");
  });

  it("keeps clones independent and rejects duplicate IDs without unregistering the original", async () => {
    const service = await createRegistry();
    const first = install(service, Only({ type: "openai", id: "first", apiKey: "test" }));
    const second = install(service, Only({ type: "openai", id: "second", apiKey: "test" }));
    first.ready();
    second.ready();
    expect(service.listProviders()).toEqual(["first", "second"]);
    const duplicate = install(service, Only({ type: "openai", id: "first", apiKey: "test" }));
    expect(() => duplicate.ready()).toThrow("model_provider_duplicate");
    duplicate.dispose();
    expect(service.listProviders()).toEqual(["first", "second"]);
    first.dispose();
    expect(service.listProviders()).toEqual(["second"]);
    second.dispose();
    expect(service.listProviders()).toEqual([]);
  });
});
