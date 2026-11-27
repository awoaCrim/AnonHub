import { systemClock } from "@yesimbot/foundation";
import { describe, expect, it } from "vitest";

import { buildPanelPayload, PanelSource } from "../src/panel-source.js";

const Status = { OFFLINE: 0, ONLINE: 1, CONNECT: 2, DISCONNECT: 3 } as const;

function context(plugins: Record<string, unknown>, providers: string[] = []) {
  return {
    clock: systemClock(),
    loader: { config: { plugins: { "group:yesimbot": plugins } } },
    bots: [],
    yesimbot: {
      model: {
        listProviders: () => providers,
        listChatModels: () => [],
        listEmbeddingModels: () => [],
        getDefaultChatModelId: () => undefined,
        getDefaultEmbeddingModelId: () => undefined,
      },
    },
  };
}

describe("unified Provider console status", () => {
  it.each([
    [Status.ONLINE, "online"],
    [Status.CONNECT, "configured"],
    [Status.OFFLINE, "configured"],
    [Status.DISCONNECT, "configured"],
  ])("uses the actual adapter status %s rather than bot existence", (status, state) => {
    const ctx = context({ "adapter-onebot:qq": { selfId: "12345" } });
    ctx.bots = [{ platform: "onebot", selfId: "12345", status }] as never;
    expect(buildPanelPayload(ctx as never, []).adapters[0].state).toBe(state);
  });
  it("retains disabled and failed adapter states even when a bot exists", () => {
    const ctx = context({ "~adapter-onebot:qq": { selfId: "12345" }, "adapter-onebot:failed": { selfId: "67890" } });
    ctx.bots = [
      { platform: "onebot", selfId: "12345", status: Status.ONLINE },
      { platform: "onebot", selfId: "67890", status: Status.OFFLINE, error: new Error("connection failed") },
    ] as never;
    const adapters = buildPanelPayload(ctx as never, []).adapters;
    expect(adapters.find((adapter) => adapter.configPath === "qq")?.state).toBe("disabled");
    expect(adapters.find((adapter) => adapter.configPath === "failed")?.state).toBe("error");
  });
  it("uses each clone's configured ID and opens the correct instance", () => {
    const payload = buildPanelPayload(
      context(
        {
          "yesimbot-model-provider:first": { connections: [{ type: "google", id: "custom-google" }] },
          "yesimbot-model-provider:second": { connections: [{ type: "openai", id: "custom-openai" }] },
        },
        ["custom-google", "custom-openai"],
      ) as never,
      [],
    );
    expect(payload.plugins).toEqual([
      expect.objectContaining({ label: "模型接入", status: "enabled", detail: "已注册：custom-google", configPath: "first" }),
      expect.objectContaining({ label: "模型接入", status: "enabled", detail: "已注册：custom-openai", configPath: "second" }),
    ]);
  });

  it("uses protocol defaults rather than the package name and reports missing/disabled instances", () => {
    const payload = buildPanelPayload(
      context(
        {
          "yesimbot-model-provider:google": { connections: [{ type: "google" }] },
          "yesimbot-model-provider:missing": { connections: [{ type: "anthropic", id: "missing" }] },
          "~yesimbot-model-provider:off": { connections: [{ type: "deepseek", id: "not-registered" }] },
        },
        ["google"],
      ) as never,
      [],
    );
    expect(payload.plugins.find((plugin) => plugin.configPath === "google")).toMatchObject({ status: "enabled", detail: "已注册：google" });
    expect(payload.plugins.find((plugin) => plugin.configPath === "missing")).toMatchObject({
      status: "attention",
      detail: "已启用但 provider 未注册：missing",
    });
    expect(payload.plugins.find((plugin) => plugin.configPath === "off")).toMatchObject({ status: "disabled", detail: "未启用" });
    expect(payload.attention.some((issue) => issue.message.includes("not-registered"))).toBe(false);
  });

  it("flags duplicate effective IDs without treating disabled clones as registrations", () => {
    const payload = buildPanelPayload(
      context(
        {
          "yesimbot-model-provider:first": { connections: [{ type: "openai" }] },
          "yesimbot-model-provider:second": { connections: [{ type: "openai", id: "openai" }] },
          "~yesimbot-model-provider:off": { connections: [{ type: "openai", id: "openai" }] },
        },
        ["openai"],
      ) as never,
      [],
    );
    const active = payload.plugins.filter((plugin) => plugin.enabled);
    expect(new Set(payload.plugins.map((plugin) => plugin.key)).size).toBe(3);
    expect(active).toHaveLength(2);
    expect(active.every((plugin) => plugin.status === "attention" && plugin.detail === "重复的 provider 标识：openai")).toBe(true);
    expect(payload.plugins.find((plugin) => !plugin.enabled)).toMatchObject({ status: "disabled", detail: "未启用" });
  });

  it("does not treat the console's built-in web chat as an account adapter or onboarding target", () => {
    const ctx = context({ "yesimbot-console:console": { secret: "x" }, "~adapter-onebot:qq": { selfId: "12345" } });
    ctx.bots = [{ platform: "web", selfId: "bot", status: Status.ONLINE }] as never;
    const payload = buildPanelPayload(ctx as never, []);
    expect(payload.adapters.map((adapter) => adapter.platform)).toEqual(["onebot"]);
    expect(payload.onboarding.steps.find((step) => step.id === "adapter")).toMatchObject({ done: false, target: "/plugins/adapter" });
    expect(payload.health.botCount).toBe(0);
  });
  it("opens the actual configured Provider instance during onboarding", () => {
    const payload = buildPanelPayload(context({ "~yesimbot-model-provider:connection": { connections: [{ type: "openai" }] } }) as never, []);
    expect(payload.onboarding.steps.find((step) => step.id === "model")?.target).toBe("/plugins/connection");
  });
  it("adds the role step only when roleplay is installed, done once enabled with a card", () => {
    const steps = (plugins: Record<string, unknown>) => buildPanelPayload(context(plugins) as never, []).onboarding.steps;
    expect(steps({}).map((step) => step.id)).toEqual(["adapter", "model", "channels"]);
    const role = (plugins: Record<string, unknown>) => steps(plugins).find((step) => step.id === "role");
    expect(steps({ "yesimbot-roleplay:r": {} }).map((step) => step.id)).toEqual(["adapter", "model", "role", "channels"]);
    expect(role({ "yesimbot-roleplay:r": {} })?.done).toBe(false);
    expect(role({ "yesimbot-roleplay:r": { characterCard: "  " } })?.done).toBe(false);
    expect(role({ "~yesimbot-roleplay:r": { characterCard: "abc" } })?.done).toBe(false);
    expect(role({ "yesimbot-roleplay:r": { characterCard: "abc" } })).toMatchObject({ done: true, target: "/plugins/r" });
  });
  it("projects a collection as one row, excluding disabled children and secret options", () => {
    const payload = buildPanelPayload(
      context(
        {
          "yesimbot-model-provider:models": {
            connections: [
              { type: "google", id: "google-line", apiKey: "private-key", baseURL: "private-url" },
              { type: "openai", id: "openai-line" },
              { enabled: false, id: "disabled-line" },
            ],
          },
        },
        ["google-line", "openai-line"],
      ) as never,
      [],
    );
    expect(payload.plugins).toEqual([expect.objectContaining({ status: "enabled", detail: "已注册：google-line、openai-line", configPath: "models" })]);
    expect(JSON.stringify(payload)).not.toMatch(/private-key|private-url|disabled-line/);
  });

  it("detects duplicates inside and across collections", () => {
    const payload = buildPanelPayload(
      context(
        {
          "yesimbot-model-provider:models": { connections: [{ id: "shared" }, { id: "shared" }, { id: "missing" }] },
          "yesimbot-model-provider:other": { connections: [{ id: "shared" }] },
          "~yesimbot-model-provider:off": { connections: [{ id: "missing" }] },
        },
        ["shared"],
      ) as never,
      [],
    );
    expect(payload.plugins.filter((plugin) => plugin.enabled).every((plugin) => plugin.detail === "重复的 provider 标识：shared")).toBe(true);
    expect(payload.plugins.find((plugin) => !plugin.enabled)?.status).toBe("disabled");
  });

  it("reports missing collection registrations and treats an empty list as empty", () => {
    const payload = buildPanelPayload(
      context({
        "yesimbot-model-provider:empty": { connections: [] },
        "yesimbot-model-provider:models": { connections: [{ type: "google" }, { enabled: false }] },
      }) as never,
      [],
    );
    expect(payload.plugins.find((plugin) => plugin.configPath === "empty")).toMatchObject({ status: "enabled", detail: "未启用任何模型连接" });
    expect(payload.plugins.find((plugin) => plugin.configPath === "models")).toMatchObject({ status: "attention", detail: "已启用但 provider 未注册：google" });
    expect(JSON.stringify(payload.attention)).not.toContain("openai");
  });
});

describe("panel refresh lifecycle", () => {
  it("gives no payload after scope disposal or core removal", async () => {
    for (const dispose of [false, true]) {
      const hooks = new Map<string, () => void>();
      const ctx = {
        ...context({}),
        debounce: () => () => {},
        on: (name: string, callback: () => void) => hooks.set(name, callback),
      };
      const provider = new PanelSource(ctx as never);
      expect(await provider.get()).not.toBeNull();
      if (dispose) hooks.get("dispose")!();
      else Reflect.deleteProperty(ctx, "yesimbot");
      expect(await provider.get()).toBeNull();
    }
  });
});
