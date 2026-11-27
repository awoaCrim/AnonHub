import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { memoryLibraryService } from "../src/library-service.js";
import { MemoryLibrary } from "../src/library.js";
import { EvidenceStore } from "../src/store/evidence.js";
import { memoryStore } from "./support.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("lists a memory's attachments for the owner and serves them only for memories of this instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorizer-managed-"));
  roots.push(root);
  const rows: Record<string, unknown>[] = [];
  const matches = (query: Record<string, unknown>) => rows.filter((row) => Object.entries(query).every(([key, value]) => row[key] === value));
  const model = {
    extend: vi.fn(),
    get: async (_table: string, query: Record<string, unknown>) => matches(query).map((row) => ({ ...row })),
    create: async (_table: string, row: Record<string, unknown>) => void rows.push({ ...row }),
    set: async (_table: string, query: Record<string, unknown>, patch: Record<string, unknown>) =>
      void matches(query).forEach((row) => Object.assign(row, patch)),
    remove: async () => undefined,
  };
  const store = memoryStore(model, { tenantId: TENANT });
  const evidence = new EvidenceStore(root);
  const service = memoryLibraryService(new MemoryLibrary({ store, evidence }));
  const kept = await store.create({ type: "fact", content: "千早爱音的立绘", scope: "shared", platform: "onebot", importance: 0.8, confidence: 0.9, tags: [] });
  const plain = await store.create({ type: "fact", content: "周五不发广告", scope: "shared", platform: "onebot", importance: 0.8, confidence: 0.9, tags: [] });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await evidence.attach(kept.id, [{ bytes: png, mediaType: "image/png", name: "立绘.png", messageId: "m1" }]);

  const listed = await service.list();
  expect(listed.memories.find((memory) => memory.id === kept.id)?.attachments).toEqual([{ index: 1, name: "立绘.png", mediaType: "image/png", byteLength: 8 }]);
  expect(listed.memories.find((memory) => memory.id === plain.id)).not.toHaveProperty("attachments");
  await expect(service.attachment(kept.id, 1)).resolves.toEqual({ bytes: png, mediaType: "image/png", filename: "立绘.png" });
  await expect(service.attachment(kept.id, 2)).rejects.toThrow("memory_not_found");
  await expect(service.attachment("00000000-0000-4000-8000-000000000000", 1)).rejects.toThrow("memory_not_found");
});
