import { defineModuleConfig } from "@yesimbot/foundation";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { ConfigStore, configPathKey } from "../src/config/store.js";
const record = Symbol.for("koishi.loader.record");
function fixture() {
  const root = { scope: { [record]: {} } };
  const group = { scope: { [record]: {} } };
  root.scope[record]["group:g"] = { ctx: group, isActive: true };
  const config = {
    plugins: {
      $label: "root",
      "group:g": { $label: "group", "~example:a": { password: "private", future: { x: 3 } }, "other:b": {} },
      "yesimbot-console:admin": { admin: { enabled: true } },
      "@example/scoped:c": {},
    },
  };
  const reload = vi.fn(async () => ({ isActive: true }));
  const ctx = {
    baseDir: "/nonexistent",
    schema: { get: () => undefined },
    lifecycle: { flush: vi.fn(async () => {}) },
    loader: {
      config,
      entry: root,
      writable: true,
      isTruthyLike: (value: unknown) => value !== false,
      resolve: vi.fn(async () => ({
        moduleConfig: defineModuleConfig("store-fixture", z.looseObject({ password: z.string().optional().meta({ secret: true }) })),
      })),
      reload,
      unload: vi.fn(),
      writeConfig: vi.fn(async () => {}),
    },
  };
  return { ctx, config, reload, store: new ConfigStore(ctx as never) };
}
describe("independent plugin config writer", () => {
  it("preserves native ordering, disabled groups, metadata, unknown fields and defaults", async () => {
    const { store, config, ctx } = fixture();
    const before = structuredClone(config);
    const read = await store.read("group:g/~example:a");
    expect(read.config.password).toEqual({ $secret: true, sourcePath: ["password"] });
    await store.update(read.revision, "group:g/~example:a", read.config);
    expect(config).toEqual(before);
    expect(ctx.loader.writeConfig).not.toHaveBeenCalled();
    const result = await store.setEnabled(store.revision(), "group:g/~example:a", true);
    expect(result.path).toBe("group:g/example:a");
    expect(Object.keys(config.plugins["group:g"])).toEqual(["$label", "example:a", "other:b"]);
    expect(config.plugins["group:g"]["example:a"]).toEqual(before.plugins["group:g"]["~example:a"]);
  });
  it.each([false, true])("keeps disabled configuration when Loader renames it during disposal (deferred: %s)", async (deferred) => {
    const { store, config, ctx } = fixture();
    const group = config.plugins["group:g"];
    await store.setEnabled(store.revision(), "group:g/~example:a", true);
    const before = structuredClone(group["example:a"]);
    const nativeDispose = () => {
      const entries = Object.entries(group).map(([key, value]) => [key === "example:a" ? "~example:a" : key, value]);
      const saved = group["example:a"];
      delete group["example:a"];
      delete group["~example:a"];
      for (const key of Object.keys(group)) delete group[key];
      Object.assign(group, Object.fromEntries(entries));
      group["~example:a"] = saved;
    };
    ctx.loader.unload.mockImplementation(() => {
      if (deferred) ctx.lifecycle.flush.mockImplementationOnce(async () => nativeDispose());
      else nativeDispose();
    });
    const result = await store.setEnabled(store.revision(), "group:g/example:a", false);
    expect(result.path).toBe("group:g/~example:a");
    expect(Object.keys(group)).toEqual(["$label", "~example:a", "other:b"]);
    expect(group["~example:a"]).toEqual(before);
    await store.setEnabled(store.revision(), result.path!, true);
    expect(group["example:a"]).toEqual(before);
  });
  it("shares a transaction lock across store instances and rejects the queued stale revision", async () => {
    const { store, ctx } = fixture();
    const second = new ConfigStore(ctx as never);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.loader.writeConfig.mockImplementationOnce(async () => {
      await wait;
    });
    const revision = store.revision();
    const first = store.setEnabled(revision, "group:g/~example:a", true);
    await vi.waitFor(() => expect(ctx.loader.writeConfig).toHaveBeenCalledOnce());
    const queued = second.remove(revision, "group:g/other:b");
    release();
    await first;
    await expect(queued).rejects.toMatchObject({ status: 409, code: "config_changed" });
  });
  it("rolls back failed forks without restarting unrelated console auth", async () => {
    const { store, config, reload } = fixture();
    const before = structuredClone(config);
    reload.mockResolvedValueOnce({ isActive: false });
    await expect(store.setEnabled(store.revision(), "group:g/~example:a", true)).rejects.toMatchObject({ status: 503, restored: true });
    expect(config).toEqual(before);
    expect(reload.mock.calls.every((call) => call[1] !== "yesimbot-console:admin")).toBe(true);
  });
  it("restores disk configuration and scope object identity even when runtime rollback also fails", async () => {
    const { store, config, reload, ctx } = fixture();
    const root = config.plugins;
    const group = config.plugins["group:g"];
    const before = structuredClone(config);
    reload.mockImplementation(async () => {
      throw new Error("private runtime error");
    });
    await expect(store.update(store.revision(), "group:g/other:b", { password: "changed" })).rejects.toMatchObject({ status: 503, restored: false });
    expect(config).toEqual(before);
    expect(config.plugins).toBe(root);
    expect(config.plugins["group:g"]).toBe(group);
    expect(ctx.loader.writeConfig).toHaveBeenCalled();
  });
  it("enforces member policy before activating a group with unauthorized descendants", async () => {
    const { store, config, reload } = fixture();
    vi.stubEnv("YESIMBOT_TENANT_ID", "12345678-1234-4234-8234-123456789abc");
    try {
      config.plugins["~group:restricted"] = { "not-granted:x": {} };
      await expect(store.setEnabled(store.revision(), "~group:restricted", true)).rejects.toMatchObject({ code: "not_permitted" });
      await expect(store.read("group:g/~example:a")).rejects.toMatchObject({ code: "not_permitted" });
      expect(reload).not.toHaveBeenCalled();
      expect((await store.catalog.snapshot()).tree.some((entry) => entry.name === "@example/scoped")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("protects console ancestors and rejects whole group replacement", async () => {
    const { store, config } = fixture();
    config.plugins["group:g"]["yesimbot-console:nested"] = { admin: { enabled: true } };
    for (const path of ["group:g", "yesimbot-console:admin"]) {
      await expect(store.remove(store.revision(), path)).rejects.toMatchObject({ code: "locked" });
      await expect(store.update(store.revision(), path, {})).rejects.toMatchObject({ code: "locked" });
      await expect(store.setEnabled(store.revision(), path, false)).rejects.toMatchObject({ code: "locked" });
    }
  });
  it("uses unambiguous encoded path segments for scoped npm plugin keys", async () => {
    const { store } = fixture();
    expect(store.resolve(configPathKey("@example/scoped:c")).key).toBe("@example/scoped:c");
    expect((await store.catalog.snapshot()).tree.find((entry) => entry.name === "@example/scoped")?.path).toBe("@example%2Fscoped:c");
  });
});
