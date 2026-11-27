import { observeLogs, type LogRecord } from "@yesimbot/foundation";
import { afterEach, describe, expect, it } from "vitest";

import { ModelService } from "../src/models/index.js";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function provider(id: string, embeddings: string[] = [], chats: string[] = []) {
  return {
    id,
    capabilities: { chat: chats.length > 0, embedding: embeddings.length > 0, image: false },
    chatModels: () => chats.map((model) => ({ id: model })),
    embeddingModels: () => embeddings.map((model) => ({ id: model })),
    chat: () => ({}) as never,
    embedding: () => ({}) as never,
  };
}

function ignoredWarnings(): Record<string, unknown>[] {
  const warnings: Record<string, unknown>[] = [];
  stops.push(
    observeLogs((record: LogRecord) => {
      if (record.level === "warn" && record.event === "model.config_ignored") warnings.push(record as unknown as Record<string, unknown>);
    }),
  );
  return warnings;
}

describe("model settings the registry cannot apply", () => {
  it("stay quiet while their provider has not registered, and warn once for a model the provider lacks", () => {
    const warnings = ignoredWarnings();
    const service = new ModelService({ baseDir: "/", emit: () => {} }, { basePath: "/unused" });
    Object.assign(service, {
      modelsConfig: {
        defaults: { embedding: "late:embed-1" },
        aliases: { "default-embedding": "late:embed-1" },
        chat: { "early:gone": {} },
        embedding: { "late:embed-1": {} },
      },
    });
    service.register(provider("early", [], ["chat-1"]));
    service.register(provider("other", [], ["chat-2"]));
    service.register(provider("late", ["embed-1"]));

    expect(service.resolveEmbedding("default-embedding")).toMatchObject({ modelId: "embed-1" });
    expect(warnings.map((warning) => [warning.entry, warning.fullId])).toEqual([["chat override", "early:gone"]]);
  });

  it("warns again after an entry was resolved and broke anew", () => {
    const warnings = ignoredWarnings();
    const service = new ModelService({ baseDir: "/", emit: () => {} }, { basePath: "/unused" });
    Object.assign(service, { modelsConfig: { defaults: {}, aliases: {}, chat: { "p:old": {} }, embedding: {} } });
    const first = service.register(provider("p", [], ["old"]));
    first();
    service.register(provider("p", [], ["new"]));
    const second = service.register(provider("q", [], ["x"]));
    second();
    expect(warnings.map((warning) => warning.fullId)).toEqual(["p:old"]);
  });
});
