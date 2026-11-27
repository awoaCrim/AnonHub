import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";
import { computed, createSSRApp, reactive, ref } from "vue";

import type { ModelSettingsConnection } from "../src/model-settings-types";
import ConnectionEditor from "../web/src/components/models/ConnectionEditor.vue";
import { connectionEndpoint, protocolLabel, protocolOptions, setConnectionEndpoint } from "../web/src/state/model-settings-state";
import { connectionSubtitle, MODELS_PAGE } from "../web/src/state/models-page";

function connection(type: string, options: ModelSettingsConnection["options"] = {}): ModelSettingsConnection {
  return {
    key: "connection:0",
    id: "uwoacrimson",
    enabled: true,
    type,
    baseURL: "https://gateway.example/v1",
    hasApiKey: true,
    chatModels: [{ id: "wbcn/deepseek-v4.1-flash" }],
    embeddingModels: [],
    options,
  };
}

async function editor(value: ModelSettingsConnection, tab: "connection" | "advanced") {
  const state = reactive({ draft: { connections: [value], writable: true }, selectedKey: value.key, loading: false, saving: false });
  const app = createSSRApp(ConnectionEditor);
  app.provide(MODELS_PAGE, {
    view: { reload() {} },
    state,
    selected: computed(() => state.draft.connections[0]),
    creating: ref(undefined),
    editable: computed(() => true),
    tab: ref(tab),
  } as never);
  return renderToString(app);
}

// User, 2026-11-19: 「模型服务按照端点进行划分，openai也有两种端点啊……我需要的是chat端点」. The endpoint used to hide under
// 高级 → API 格式, and the gateway connection there was on Responses.
describe("model service endpoints", () => {
  it("offers each endpoint as its own protocol, OpenAI's two included", () => {
    expect(protocolOptions.map((option) => option.label)).toEqual(["OpenAI Chat Completions", "OpenAI Responses", "Anthropic", "Google", "DeepSeek"]);
    expect(protocolOptions[0]).toMatchObject({ value: "openai-chat", note: "/chat/completions" });
    expect(protocolOptions[1]).toMatchObject({ value: "openai-responses", note: "/responses" });
  });

  it("reads an OpenAI connection without a format as Chat Completions and names the endpoint everywhere", () => {
    expect(connectionEndpoint(connection("openai"))).toBe("openai-chat");
    expect(connectionEndpoint(connection("openai", { format: "responses" }))).toBe("openai-responses");
    expect(connectionEndpoint(connection("deepseek"))).toBe("deepseek");
    expect(protocolLabel(connection("openai", { format: "responses" }))).toBe("OpenAI Responses");
    expect(protocolLabel(connection("legacy-provider"))).toBe("legacy-provider");
    expect(connectionSubtitle(connection("openai", { format: "chat" }))).toContain("OpenAI Chat Completions");
  });

  it("saves the endpoint as type and format and drops the options the new endpoint does not read", () => {
    const value = connection("openai", { format: "responses", webSearch: true, imageToolResultSupport: "native", imageToolResultPlacement: "tool-output" });
    setConnectionEndpoint(value, "openai-chat");
    expect(value).toMatchObject({ type: "openai", options: { format: "chat", imageToolResultSupport: "native" } });
    expect(value.options).not.toHaveProperty("webSearch");
    expect(value.options).not.toHaveProperty("imageToolResultPlacement");
    setConnectionEndpoint(value, "openai-responses");
    expect(value.options).toEqual({ format: "responses", imageToolResultSupport: "native" });
    const search = connection("openai", { format: "responses", webSearch: true });
    setConnectionEndpoint(search, "anthropic");
    expect(search).toMatchObject({ type: "anthropic", options: { webSearch: true } });
    expect(search.options).not.toHaveProperty("format");
    setConnectionEndpoint(search, "deepseek");
    expect(search).toMatchObject({ type: "deepseek", options: {} });
    const fresh = connection("openai");
    setConnectionEndpoint(fresh, "openai-responses");
    expect(fresh.options).toEqual({ format: "responses" });
  });

  it("shows the endpoint in the protocol picker and keeps Responses-only options off a Chat connection", async () => {
    const chat = await editor(connection("openai", { format: "chat" }), "connection");
    expect(chat).toContain("OpenAI Chat Completions");
    expect(await editor(connection("openai", { format: "responses" }), "connection")).toContain("OpenAI Responses");
    const chatAdvanced = await editor(connection("openai", { format: "chat" }), "advanced");
    expect(chatAdvanced).not.toContain("API 格式");
    expect(chatAdvanced).not.toContain("启用原生网页搜索");
    expect(chatAdvanced).not.toContain("图片结果位置");
    expect(chatAdvanced).toContain("图片工具结果能力");
    const responsesAdvanced = await editor(connection("openai", { format: "responses" }), "advanced");
    expect(responsesAdvanced).toContain("启用原生网页搜索");
    expect(responsesAdvanced).toContain("图片结果位置");
  });
});
