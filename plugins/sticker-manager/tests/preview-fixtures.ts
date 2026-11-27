import { createToolMessage, EphemeralImageProjectionStore, jsonSchema, type AgentMessage, type AgentTool } from "@yesimbot/agent-runtime";
import { contentHash, parseConfig } from "@yesimbot/foundation";
import type { ChannelContext, ImagePreviewCapability } from "koishi-plugin-yesimbot";
import { PNG } from "pngjs";
import { vi } from "vitest";

import { moduleConfig } from "../src/config.js";
import { StickerDeliveryService } from "../src/delivery.js";
import { stickerFailure } from "../src/errors.js";
import { StickerPreviewGate, StickerSendSlot } from "../src/preview-evidence.js";
import { createStickerPreviewTool } from "../src/preview-tool.js";
import type { StickerStore } from "../src/store.js";
import { createStickerTools } from "../src/tools.js";
import type { StickerConfig, StickerProjection } from "../src/types.js";

export const scope: ChannelContext = { type: "guild", platform: "test", channelId: "room", guildId: "room" };

export const config: StickerConfig = parseConfig(moduleConfig, { scope: "global", tagMode: false });

export const pngBytes = (() => {
  const png = new PNG({ width: 2, height: 1 });
  png.data.set([255, 0, 0, 255, 0, 0, 255, 255]);
  return new Uint8Array(PNG.sync.write(png));
})();

export const stickerId = contentHash(pngBytes);

export function sticker(overrides: Partial<StickerProjection> = {}): StickerProjection {
  return {
    id: stickerId,
    category: "meme",
    tags: [],
    mime: "image/png",
    size: pngBytes.length,
    source: { kind: "import" },
    usageCount: 0,
    lastUsedAt: null,
    createdAt: "2026-01-01",
    ...overrides,
  };
}

export function createDeps(overrides: Partial<StickerConfig> = {}, mode: "native" | "vision" | "unavailable" = "native") {
  const store = {
    listCategories: vi.fn(async () => [{ category: "meme", count: 1 }]),
    listTags: vi.fn(async () => []),
    get: vi.fn(async (): Promise<StickerProjection | null> => sticker()),
    save: vi.fn(async (input: { tags?: readonly string[] }) => ({ status: "created", sticker: sticker({ tags: [...(input.tags ?? [])] }) })),
    search: vi.fn(async () => [sticker()]),
    listByScopeKey: vi.fn(async () => [sticker()]),
    listCategory: vi.fn(async () => [sticker()]),
    random: vi.fn(async (): Promise<StickerProjection | null> => sticker()),
    readBytes: vi.fn(async () => pngBytes),
    markUsed: vi.fn(async () => sticker({ usageCount: 1 })),
  };
  const bindings = new Set<{ sticker: StickerProjection; release(): void }>();
  const boundStore = Object.assign(store, {
    bindForDelivery: vi.fn(async (scopeKey: string, id: string, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const record = await store.get(scopeKey, id);
      if (!record) return null;
      const binding = {
        sticker: record,
        release: () => {
          bindings.delete(binding);
        },
      };
      bindings.add(binding);
      return binding;
    }),
    isBindingCurrent: (binding: { sticker: StickerProjection; release(): void }) => bindings.has(binding),
    startDelivery: async <T>(binding: { sticker: StickerProjection; release(): void }, start: (bytes: Uint8Array) => { value: T }, signal?: AbortSignal) => {
      const bytes = await store.readBytes();
      signal?.throwIfAborted();
      return bindings.has(binding) ? start(bytes) : null;
    },
  });
  const projection = new EphemeralImageProjectionStore();
  const gate = new StickerPreviewGate();
  const slot = new StickerSendSlot();
  const sender = { sendWithProof: vi.fn(async (): Promise<readonly string[]> => ["sent-1"]) };
  const assets = { put: vi.fn(async () => "a".repeat(32)), get: vi.fn(async () => pngBytes), clear: vi.fn(async () => undefined) };
  const capability: ImagePreviewCapability = {
    mode,
    preview: (request) => (projection.stageFrames(request) ? { mode: "native" } : { mode: "unavailable", error: "resource_read_aborted" }),
    describe: vi.fn(async () => "红色与蓝色的画面"),
  };
  const effective = { ...config, ...overrides };
  const preview = createStickerPreviewTool({
    store: store as unknown as StickerStore,
    config: effective,
    scopeKey: "global",
    projection,
    previewCapability: capability,
    gate,
  });
  const delivery = new StickerDeliveryService({ store: store as unknown as StickerStore, sender, scope, config: effective, sendSlot: slot, previewGate: gate });
  // Sending goes through send_message's sticker parts in production; this drives the same delivery service one call at a time.
  const sendTool: AgentTool<{ sticker_id?: string; continue?: boolean }, Record<string, unknown>> = {
    name: "sticker_send",
    terminal: (input) => !input.continue,
    inputSchema: jsonSchema({ type: "object" }),
    execute: async ({ sticker_id }, execution) => {
      const prepared = await delivery.preflight({
        stickerId: sticker_id as string,
        turnId: execution.turnId,
        messages: execution.messages,
        signal: execution.abortSignal,
      });
      if ("error" in prepared) return stickerFailure(prepared.error);
      const result = await prepared.lease.send(execution.abortSignal);
      if (result.status !== "confirmed") {
        const code = result.error ?? "sticker_delivery_uncertain";
        return stickerFailure(code, code === "sticker_delivery_uncertain" ? "unknown" : "none");
      }
      return {
        ok: true,
        id: prepared.lease.stickerId,
        category: prepared.lease.category,
        tags: prepared.lease.tags,
        ...(result.warning ? { warning: result.warning } : {}),
      };
    },
  };
  const tools: AgentTool[] = [
    ...createStickerTools({ store: store as unknown as StickerStore, assets, scope, config: effective }),
    sendTool as unknown as AgentTool,
  ];
  const tool = (name: string) => tools.find((entry) => entry.name === name)!;
  const messages: AgentMessage[] = [];
  const execute = (target: AgentTool, input: unknown, turnId = "turn-1", signal?: AbortSignal) =>
    target.execute(input, {
      toolCallId: "call",
      turnId,
      messages: [...messages],
      abortSignal: signal,
    } as never);
  const view = async (input: Record<string, unknown> = { sticker_id: stickerId }, turnId = "turn-1", signal?: AbortSignal) => {
    const output = await preview.execute(input, { toolCallId: "preview-call", turnId, messages: [...messages], abortSignal: signal } as never);
    const modelOutput = await preview.toModelOutput!({ toolCallId: "preview-call", input, output });
    messages.push(createToolMessage([{ type: "tool-result", toolName: "sticker_preview", toolCallId: "preview-call", output: modelOutput }]));
    return output;
  };
  return { store: boundStore, delivery, sender, assets, projection, gate, slot, capability, preview, tools, tool, messages, execute, view };
}
