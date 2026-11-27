import { describe, expect, it, vi } from "vitest";

import { ModelService } from "../src/models/index.js";

function fixture() {
  const service = new ModelService({ baseDir: "/", emit: () => {} }, { basePath: "/unused" });
  const adapter = { model: {} as never, edit: vi.fn(async () => ({ images: [] })) };
  const entries = [
    { id: "image-1", name: "Images" },
    { id: "image-hidden", hidden: true },
  ];
  const provider = {
    id: "shared",
    capabilities: { chat: true, embedding: false, image: true },
    chatModels: () => [{ id: "vision-only" }],
    embeddingModels: () => [],
    imageModels: () => entries,
    image: vi.fn(() => adapter),
    chat: vi.fn(() => ({}) as never),
  };
  return { service, provider, adapter, entries };
}

describe("Images model registry", () => {
  it("keeps chat and embedding aliases independent from identically named Images IDs", () => {
    const { service, provider, adapter } = fixture();
    // The file has already been loaded when a later provider registration adds Images.
    Object.assign(service, {
      modelsConfig: {
        defaults: {},
        aliases: { "shared:image-1": "shared:vision-only", "shared:image-hidden": "shared:embedding-1", imageAlias: "shared:image-1" },
        chat: {},
        embedding: {},
      },
    });
    const chat = { specificationVersion: "v3", provider: "shared", modelId: "vision-only", supportedUrls: {} };
    const embedding = { specificationVersion: "v3", provider: "shared", modelId: "embedding-1" };
    const register = (images: boolean) =>
      service.register({
        ...provider,
        capabilities: { chat: true, embedding: true, image: images },
        chat: () => chat as never,
        embeddingModels: () => [{ id: "embedding-1" }],
        embedding: () => embedding as never,
      });
    const dispose = register(false);
    expect(service.resolveChatModel("shared:image-1").fullId).toBe("shared:vision-only");
    expect(service.resolveEmbedding("shared:image-hidden")).toMatchObject({ modelId: "embedding-1" });
    dispose();
    register(true);
    expect(service.resolveChatModel("shared:image-1").fullId).toBe("shared:vision-only");
    expect(service.resolveEmbedding("shared:image-hidden")).toMatchObject({ modelId: "embedding-1" });
    expect(service.resolveImage("shared:image-1")).toMatchObject({ fullId: "shared:image-1", model: adapter.model, edit: adapter.edit });
    expect(service.resolveImage("shared:image-hidden").fullId).toBe("shared:image-hidden");
    expect(() => service.resolveImage("imageAlias")).toThrow("model_not_found");
  });

  it("registers connection-owned adapters independently from chat and isolates returned entries", () => {
    const { service, provider, adapter, entries } = fixture();
    const revision = service.revision;
    const dispose = service.register(provider);
    expect(service.revision).toBeGreaterThan(revision);
    expect(service.listImageModels()).toEqual(entries.map((config) => ({ fullId: `shared:${config.id}`, config })));
    const resolved = service.resolveImage("shared:image-1");
    expect(resolved).toEqual({ fullId: "shared:image-1", providerId: "shared", modelId: "image-1", entry: { id: "image-1", name: "Images" }, ...adapter });
    expect(provider.image).toHaveBeenCalledWith("image-1");
    expect(provider.chat).not.toHaveBeenCalled();
    resolved.entry.name = "changed";
    service.listImageModels()[0]!.config.name = "changed again";
    entries[0]!.name = "provider mutation";
    expect(service.resolveImage("shared:image-1").entry.name).toBe("Images");
    dispose();
    expect(service.listImageModels()).toEqual([]);
    expect(() => service.resolveImage("shared:image-1")).toThrow("model_not_found");
  });

  it("does not infer an Images route from chat, an undeclared ID, or missing image capability", () => {
    const { service, provider } = fixture();
    service.register(provider);
    for (const id of ["shared:vision-only", "shared:missing", "", "shared", "other:image-1"]) {
      expect(() => service.resolveImage(id)).toThrow("model_not_found");
    }
    expect(provider.image).not.toHaveBeenCalled();
    expect(provider.chat).not.toHaveBeenCalled();
    const unavailable = fixture();
    unavailable.service.register({ ...unavailable.provider, capabilities: { chat: true, embedding: false } });
    expect(unavailable.service.listImageModels()).toEqual([]);
    expect(() => unavailable.service.resolveImage("shared:image-1")).toThrow("model_not_found");
  });

  it("lists the visible Images choices a picker offers", () => {
    const { service, provider } = fixture();
    service.register(provider);
    expect(
      service
        .listImageModels()
        .filter((model) => !model.config.hidden)
        .map((model) => model.fullId),
    ).toEqual(["shared:image-1"]);
  });
});
