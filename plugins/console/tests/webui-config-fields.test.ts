import { expect, it, vi } from "vitest";

import { ApiError } from "../web/src/lib/api";
import { createConfigFieldsEditor, schemaAt, schemaDefault, writePath } from "../web/src/state/config-fields";
import { createDraft } from "./legacy-draft-fixture";

function drafts() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => void values.set(k, v),
    removeItem: (k: string) => void values.delete(k),
  };
  return {
    values,
    for: (key: string) => createDraft<ConfigFieldsDraft>(key, 1, storage, "current"),
    old: (key: string) => createDraft<ConfigFieldsDraft>(key, 1, storage, "previous"),
  };
}
const FIELDS = ["pacing", "imageInput", "session"] as const;

it("saves only the owned fields onto the config as read, keeping other fields and secret markers", async () => {
  const d = drafts();
  const config = {
    chatModel: "a:b",
    apiKey: { $secret: true, sourcePath: ["apiKey"] },
    allowedChannels: [{ platform: "onebot", channelId: "1" }],
    pacing: { charactersPerSecond: 8, maxTotalDelayMs: 60000 },
    session: { compact: { mode: "summary", model: "legacy:chat" } },
  };
  const request = vi.fn(async (_path: string, body?: unknown) => (body ? { revision: "r2" } : { revision: "r1", config }));
  const editor = createConfigFieldsEditor(FIELDS, { request: request as never });
  await editor.load("yesimbot");
  editor.set(["pacing", "charactersPerSecond"], 12);
  editor.set(["session", "magicContext", "enabled"], true);
  editor.set(["imageInput"], false);
  editor.set(["chatModel"], "ignored");
  expect(JSON.stringify([...d.values.values()])).not.toMatch(/sourcePath|allowedChannels|chatModel/);
  expect(await editor.save()).toBe(true);
  expect(request.mock.calls[1]![1]).toEqual({
    path: "yesimbot",
    revision: "r1",
    config: {
      ...config,
      pacing: { charactersPerSecond: 12, maxTotalDelayMs: 60000 },
      imageInput: false,
      session: { compact: { mode: "summary", model: "legacy:chat" }, magicContext: { enabled: true } },
    },
  });
  expect(editor.dirty.value).toBe(false);
  expect(d.values.size).toBe(0);
});

it("clearing a value removes the key so the plugin default applies, and absent fields are never invented", async () => {
  const d = drafts();
  const config = { pacing: { charactersPerSecond: 8 }, other: 1 };
  const request = vi.fn(async (_path: string, body?: unknown) => (body ? { revision: "r2" } : { revision: "r1", config }));
  const editor = createConfigFieldsEditor(FIELDS, { request: request as never });
  await editor.load("yesimbot");
  editor.set(["pacing", "charactersPerSecond"], undefined);
  await editor.save();
  // A member's config has no `session` (host-managed); saving must not add one.
  expect(request.mock.calls[1]![1]).toEqual({ path: "yesimbot", revision: "r1", config: { pacing: {}, other: 1 } });
});

it("applies the edit to the latest config when only unrelated fields changed, and keeps a real conflict", async () => {
  const d = drafts();
  let remote: Record<string, unknown> = { pacing: { charactersPerSecond: 8 }, chatModel: "old" };
  let revision = "r1";
  const request = vi.fn(async (_path: string, body?: { revision: string; config: Record<string, unknown> }) => {
    if (!body) return { revision, config: remote };
    if (body.revision !== revision) throw new ApiError(409, "config_changed");
    remote = body.config;
    revision = "r3";
    return { revision };
  });
  const editor = createConfigFieldsEditor(FIELDS, { request: request as never });
  await editor.load("yesimbot");
  // Another tab changes the model.
  remote = { ...remote, chatModel: "new" };
  revision = "r2";
  editor.set(["pacing", "charactersPerSecond"], 10);
  expect(await editor.save()).toBe(true);
  expect(remote).toEqual({ pacing: { charactersPerSecond: 10 }, chatModel: "new" });

  // Another tab changes the same field: the edit and its draft stay for the user to decide.
  remote = { ...remote, pacing: { charactersPerSecond: 20 } };
  revision = "r4";
  editor.set(["pacing", "charactersPerSecond"], 11);
  expect(await editor.save()).toBe(false);
  expect(editor.state.error).toBeTruthy();
  expect(editor.dirty.value).toBe(true);
  expect(remote.pacing).toEqual({ charactersPerSecond: 20 });
  expect(d.values.size).toBe(0);
});

it("ignores old persisted edits for enabled and disabled instances", async () => {
  const d = drafts();
  d.old("yesimbot").save({ revision: "stale", value: { imageInput: false, chatModel: "x" } });
  const request = vi.fn(async () => ({ revision: "fresh", config: { imageInput: true } }));
  const editor = createConfigFieldsEditor(FIELDS, { request: request as never });
  await editor.load("~yesimbot");
  expect(editor.state.revision).toBe("fresh");
  expect(editor.state.value).toEqual({ imageInput: true });
  expect(editor.dirty.value).toBe(false);
  await editor.load(undefined, false);
  expect(editor.state.revision).toBe("fresh");
  expect(editor.dirty.value).toBe(false);
  expect(d.values.size).toBe(1);
});

it("ignores a late load after switching instances", async () => {
  const d = drafts();
  let resolve!: (value: unknown) => void;
  const request = vi.fn((path: string) =>
    path.endsWith("one") ? new Promise((r) => (resolve = r)) : Promise.resolve({ revision: "two", config: { imageInput: true } }),
  );
  const editor = createConfigFieldsEditor(FIELDS, { request: request as never });
  const first = editor.load("one");
  await editor.load("two");
  resolve({ revision: "one", config: { imageInput: false } });
  await first;
  expect(editor.state.path).toBe("two");
  expect(editor.state.value).toEqual({ imageInput: true });
});

it("reads defaults through intersections and transforms", () => {
  const schema = {
    type: "intersect",
    list: [
      { type: "object", dict: { pacing: { type: "object", dict: { charactersPerSecond: { type: "number", meta: { default: 8 } } } } } },
      { type: "object", dict: { session: { type: "object", dict: { n: { type: "transform", inner: { type: "number", meta: { default: 3 } } } } } } },
    ],
  };
  expect(schemaDefault(schema, ["pacing", "charactersPerSecond"])).toBe(8);
  expect(schemaAt(schema, ["session", "n"])?.type).toBe("transform");
  expect(schemaDefault(schema, ["session", "n"])).toBe(3);
  expect(schemaAt(schema, ["missing"])).toBeUndefined();
  expect(writePath({ a: { b: 1 } }, ["a", "c", "d"], 2)).toEqual({ a: { b: 1, c: { d: 2 } } });
});

it("does not flag reordered restored fields as edits, but still protects a real value change", async () => {
  const d = drafts();
  d.old("yesimbot").save({ revision: "r1", value: { pacing: { maxTotalDelayMs: 60, charactersPerSecond: 8 } } });
  const editor = createConfigFieldsEditor(FIELDS, {
    request: vi.fn(async () => ({ revision: "r1", config: { pacing: { charactersPerSecond: 8, maxTotalDelayMs: 60 } } })) as never,
  });
  await editor.load("yesimbot");
  expect(editor.dirty.value).toBe(false);
  editor.set(["pacing", "charactersPerSecond"], 9);
  expect(editor.dirty.value).toBe(true);
  editor.set(["pacing", "charactersPerSecond"], 8);
  expect(editor.dirty.value).toBe(false);
});

type ConfigFieldsDraft = { revision: string; value: Record<string, unknown> };
