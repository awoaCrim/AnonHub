import { configForm, defineModuleConfig } from "@yesimbot/foundation";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { ConfigStore } from "../src/config/store.js";
import { REQUIRED_MEMBER_PLUGINS } from "../src/shared/plugin-catalog.js";

function fixture(name: string, value: Record<string, unknown>, member = true) {
  const key = `${name}:instance`;
  const config = { plugins: { [key]: structuredClone(value) } };
  const path = { widget: "path" } as const;
  const shape = defineModuleConfig(
    "member-fixture",
    z.looseObject({
      basePath: z.string().default("data/yesimbot").meta(path),
      session: z
        .object({ magicContext: z.object({ enabled: z.boolean().optional() }).optional(), compact: z.object({ mode: z.string().optional() }).optional() })
        .optional(),
      storage: z.object({ kind: z.string().optional(), path: z.string().optional().meta(path) }).optional(),
      bash: z.object({ mounts: z.array(z.object({ source: z.string().optional() })).optional(), enableNetwork: z.boolean().optional() }).optional(),
      characterCard: z.string().optional().meta(path),
      skillPaths: z.array(z.string().meta(path)).optional(),
      password: z.string().optional().meta({ secret: true }),
      allowedChannels: z.array(z.object({ channelId: z.string().optional() })).optional(),
      label: z.string().optional(),
      admins: z.array(z.object({ platform: z.string().optional(), userId: z.string().optional() })).optional(),
    }),
  );
  const ctx = {
    baseDir: "/nonexistent",
    lifecycle: { flush: vi.fn(async () => {}) },
    loader: {
      config,
      writable: true,
      entry: {},
      isTruthyLike: () => true,
      resolve: vi.fn(async () => ({ moduleConfig: shape })),
      reload: vi.fn(async () => ({ isActive: true })),
      writeConfig: vi.fn(async () => {}),
      unload: vi.fn(),
    },
  };
  const store = new ConfigStore(ctx as never);
  vi.spyOn(store, "allowed").mockReturnValue(member ? new Set([...REQUIRED_MEMBER_PLUGINS, name]) : undefined);
  return { store, ctx, key, config, shape };
}

describe("member plugin form boundaries", () => {
  it.each([
    ["yesimbot", "basePath", { basePath: "private/core", label: "old" }],
    ["yesimbot", "session", { session: { magicContext: { triggerTokens: 50000 }, archive: { maxKB: 1024 } }, label: "old" }],
  ] as const)("hides %s storage fields and preserves exact original/default/secret values on saves", async (name, field, value) => {
    const original = { ...value, password: "saved-secret", future: { retained: true } };
    const { store, ctx, config, key, shape } = fixture(name, original);
    const nativeSchema = JSON.stringify(configForm(shape.schema));
    const read = await store.read(key);
    expect(read.config[field]).toBeUndefined();
    const schema = await store.catalog.schema(name);
    expect(schema.schema?.dict?.[field]).toBeUndefined();
    expect(JSON.stringify(configForm(shape.schema))).toBe(nativeSchema);

    await store.update(read.revision, key, read.config);
    expect(JSON.stringify(config.plugins[key])).toBe(JSON.stringify(original));
    expect(ctx.loader.writeConfig).not.toHaveBeenCalled();
    await store.update(store.revision(), key, { ...read.config, label: "updated" });
    expect(config.plugins[key]).toEqual({ ...original, label: "updated" });
    expect(ctx.loader.writeConfig).toHaveBeenCalledOnce();
    await expect(store.update(store.revision(), key, { ...read.config, [field]: "/tmp/changed" })).rejects.toMatchObject({ code: "locked", path: field });
    expect(ctx.loader.writeConfig).toHaveBeenCalledOnce();
  });

  it("hides the workspace mounts and storage path from a member and refuses to change them", async () => {
    const original = {
      bash: { mounts: [{ source: "/private/mount" }], enableNetwork: true },
      storage: { kind: "shared", path: "private/shared" },
      label: "old",
    };
    const { store, key, config } = fixture("yesimbot-workspace", original);
    const read = await store.read(key);
    expect(read.config.bash).toEqual({ enableNetwork: true });
    expect(read.config.storage).toEqual({ kind: "shared" });
    const schema = await store.catalog.schema("yesimbot-workspace");
    expect(schema.schema?.dict?.bash.dict?.mounts).toBeUndefined();
    await store.update(read.revision, key, read.config);
    expect(config.plugins[key]).toEqual(original);
    await expect(store.update(store.revision(), key, { ...read.config, bash: { mounts: [] } })).rejects.toMatchObject({ code: "locked", path: "bash.mounts" });
    await expect(store.update(store.revision(), key, { ...read.config, bash: null })).rejects.toMatchObject({ code: "locked", path: "bash" });
  });

  it("keeps omitted storage defaults and lets Channels save its core rules", async () => {
    const { store, config, key } = fixture("yesimbot", { allowedChannels: [], password: "secret" });
    const read = await store.read(key);
    await store.update(read.revision, key, { ...read.config, allowedChannels: [{ channelId: "12345" }] });
    expect(config.plugins[key]).toEqual({ allowedChannels: [{ channelId: "12345" }], password: "secret" });
    expect(Object.hasOwn(config.plugins[key], "basePath")).toBe(false);
    await expect(store.update(store.revision(), key, { ...read.config, basePath: "data/yesimbot" })).rejects.toMatchObject({ code: "locked" });
  });

  it("lets a member set their own instance's admins like the owner does", async () => {
    const { store, config, key } = fixture("yesimbot", { admins: [] });
    const read = await store.read(key);
    await store.update(read.revision, key, { ...read.config, admins: [{ platform: "onebot", userId: "10001" }] });
    expect(config.plugins[key].admins).toEqual([{ platform: "onebot", userId: "10001" }]);
  });

  it.each(["yesimbot-roleplay", "yesimbot-workspace"])("retains real resource picker fields for %s", async (name) => {
    const { store, key, config } = fixture(name, { characterCard: "old.png", skillPaths: ["skills/old"] });
    const schema = await store.catalog.schema(name);
    expect(schema.schema?.dict?.characterCard.meta?.role).toBe("path");
    expect(schema.schema?.dict?.skillPaths.inner?.meta?.role).toBe("path");
    const read = await store.read(key);
    await store.update(read.revision, key, { ...read.config, characterCard: "data/yesimbot/uploads/card.png", skillPaths: ["data/yesimbot/uploads/skills"] });
    expect(config.plugins[key]).toMatchObject({ characterCard: "data/yesimbot/uploads/card.png", skillPaths: ["data/yesimbot/uploads/skills"] });
  });

  it("hides host infrastructure but retains core and the dedicated model entry", async () => {
    const { store, config, ctx } = fixture("yesimbot", {});
    Object.assign(config.plugins, { "server:host": {}, "database-sqlite:db": {}, "adapter-onebot:qq": {}, "yesimbot-model-provider:models": {} });
    const snapshot = await store.catalog.snapshot();
    expect(snapshot.tree.map((entry) => entry.name)).toEqual(["yesimbot", "yesimbot-model-provider"]);
    expect(snapshot.available.map((entry) => entry.name)).toEqual(["yesimbot", "yesimbot-model-provider"]);
    for (const path of ["server:host", "database-sqlite:db", "adapter-onebot:qq", "yesimbot-model-provider:models"]) {
      await expect(store.read(path)).rejects.toMatchObject({ code: "locked" });
      await expect(store.update(store.revision(), path, {})).rejects.toMatchObject({ code: "locked" });
      await expect(store.setEnabled(store.revision(), path, false)).rejects.toMatchObject({ code: "locked" });
    }
    config.plugins["group:infra"] = { "server:nested": {} };
    await expect(store.setEnabled(store.revision(), "group:infra", false)).rejects.toMatchObject({ code: "locked" });
    // The dedicated model editor still uses the internal transaction adapter.
    await store.transaction(store.revision(), () => store.updateRaw("yesimbot-model-provider:models", { connections: [] }));
    expect(ctx.loader.reload).toHaveBeenCalledOnce();
  });

  it("keeps the owner advanced editor unchanged", async () => {
    const { store, key, config } = fixture("yesimbot-workspace", { storage: { path: "old" } }, false);
    const schema = await store.catalog.schema("yesimbot-workspace");
    expect(schema.schema?.dict?.storage.dict?.path).toBeDefined();
    const read = await store.read(key);
    await store.update(read.revision, key, { ...read.config, storage: { path: "new" } });
    expect(config.plugins[key].storage.path).toBe("new");
  });
});
