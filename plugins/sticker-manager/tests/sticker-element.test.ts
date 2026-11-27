import type { AgentEntry } from "@yesimbot/agent-runtime";
import { createAssistantMessage, createMessageEntry } from "@yesimbot/agent-runtime";
import type { ArtifactStore } from "koishi-plugin-yesimbot";
import { describe, expect, it, vi } from "vitest";

import { projectStickerElements, projectStickerHistoryElements } from "../src/sticker-element.js";
import type { StickerStore } from "../src/store.js";
import type { StickerProjection } from "../src/types.js";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function projection(overrides: Partial<StickerProjection> = {}): StickerProjection {
  return {
    id: "a".repeat(64),
    category: "meme",
    tags: ["猫"],
    mime: "image/png",
    size: pngBytes.byteLength,
    source: { kind: "steal" },
    usageCount: 0,
    lastUsedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createStore(overrides: Partial<StickerStore> = {}): StickerStore {
  return {
    get: vi.fn(async () => projection()),
    random: vi.fn(async () => projection()),
    listByScopeKey: vi.fn(async () => [projection()]),
    readBytes: vi.fn(async () => pngBytes),
    markUsed: vi.fn(async () => projection()),
    ...overrides,
  } as unknown as StickerStore;
}

function createArtifacts(overrides: Partial<ArtifactStore> = {}): ArtifactStore {
  const put = vi.fn(async () => `artifact://sticker/${"a".repeat(8)}-0000-7000-8000-${"b".repeat(12)}`);
  return {
    forTool: vi.fn(() => ({ put })),
    open: vi.fn(async () => {
      throw new Error("not found");
    }),
    clear: vi.fn(),
    ...overrides,
  } as unknown as ArtifactStore;
}

function assistantEntry(content: string): AgentEntry {
  return createMessageEntry(createAssistantMessage(content));
}

describe("sticker output element", () => {
  it("preserves mixed assistant text/tool calls in both projection directions", async () => {
    const store = createStore();
    const artifacts = createArtifacts();
    const entry = createMessageEntry(
      createAssistantMessage([
        { type: "text", text: '<sticker tags="猫"/><img src="artifact://sticker/00000000-0000-7000-8000-000000000000"/>' },
        { type: "tool-call", toolCallId: "send-1", toolName: "send_message", input: { messages: ["hello"] } },
      ]),
    );
    const options = { store, artifacts, scopeKey: "global" };
    expect((await projectStickerElements([entry], options))[0]).toBe(entry);
    expect((await projectStickerHistoryElements([entry], options))[0]).toBe(entry);
    expect(store.readBytes).not.toHaveBeenCalled();
    expect(store.markUsed).not.toHaveBeenCalled();
    expect(artifacts.open).not.toHaveBeenCalled();
  });

  it("resolves fuzzy tags to a sticker and replaces the element with an image", async () => {
    const store = createStore();
    const [projected] = await projectStickerElements([assistantEntry('<sticker tags="猫"/>')], {
      store,
      artifacts: createArtifacts(),
      scopeKey: "global",
    });
    const message = projected.data as { content: string };

    expect(message.content).toContain('<img src="artifact://sticker/');
    expect(store.markUsed).not.toHaveBeenCalled();
  });

  it("resolves an exact sticker id", async () => {
    const store = createStore({ get: vi.fn(async () => projection({ id: "b".repeat(64), mime: "image/gif" })) });
    const [projected] = await projectStickerElements([assistantEntry(`<sticker id="${"b".repeat(64)}"/>`)], {
      store,
      artifacts: createArtifacts(),
      scopeKey: "global",
    });
    const message = projected.data as { content: string };

    expect(store.get).toHaveBeenCalledWith("global", "b".repeat(64));
    expect(message.content).toContain('<img src="artifact://sticker/');
  });

  it("rewrites sticker artifact images back to sticker elements for model history", async () => {
    const id = "a".repeat(64);
    const artifacts = createArtifacts({ open: vi.fn(async () => ({ bytes: pngBytes, mediaType: "image/png", filename: `${id}.png` })) });
    const [projected] = await projectStickerHistoryElements([assistantEntry(`<img src="artifact://sticker/00000000-0000-7000-8000-000000000000"/>`)], {
      store: createStore(),
      artifacts,
      scopeKey: "global",
    });
    const message = projected.data as { content: string };

    expect(message.content).toBe(`<sticker id="${id}"/>`);
  });

  it("drops a missing sticker artifact image from model history", async () => {
    const [projected] = await projectStickerHistoryElements([assistantEntry(`<img src="artifact://sticker/00000000-0000-7000-8000-000000000000"/>`)], {
      store: createStore(),
      artifacts: createArtifacts(),
      scopeKey: "global",
    });
    const message = projected.data as { content: string };

    expect(message.content).toBe("");
  });
});
