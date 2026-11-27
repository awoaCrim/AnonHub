import { expect, it, vi } from "vitest";

import { createEditorRegistry } from "../web/src/lib/editor-guard";
it("aggregates nested editors into one leave confirmation and keeps changes on cancel", async () => {
  const registry = createEditorRegistry();
  let dirty = true;
  const dispose = registry.register(
    () => dirty,
    () => false,
  );
  registry.register(
    () => false,
    () => false,
  );
  let resolve!: (v: boolean) => void;
  const confirm = vi.fn(
    () =>
      new Promise<boolean>((r) => {
        resolve = r;
      }),
  );
  const first = registry.leave(confirm),
    second = registry.leave(confirm);
  expect(confirm).toHaveBeenCalledTimes(1);
  resolve(false);
  expect(await first).toBe(false);
  expect(await second).toBe(false);
  expect(registry.changed()).toBe(true);
  dirty = false;
  expect(await registry.leave(confirm)).toBe(true);
  expect(confirm).toHaveBeenCalledTimes(1);
  dirty = true;
  dispose();
  expect(registry.changed()).toBe(false);
});
it("waits for a save in flight before leaving, and stays only when it never finishes", async () => {
  const registry = createEditorRegistry();
  let saving = true;
  const dispose = registry.register(
    () => false,
    () => saving,
  );
  const confirm = vi.fn(async () => true);
  setTimeout(() => (saving = false), 120);
  expect(await registry.leave(confirm, 2000)).toBe(true);
  expect(confirm).not.toHaveBeenCalled();
  saving = true;
  expect(await registry.leave(confirm, 100)).toBe(false);
  dispose();
  expect(await registry.leave(confirm)).toBe(true);
});
