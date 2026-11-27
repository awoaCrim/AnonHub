import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRoleCard } from "@yesimbot/character-cards";
import { blankRoleCardText } from "@yesimbot/contracts/role-cards";
import { afterEach, expect, it, vi } from "vitest";

import { CharacterCards } from "../src/characters/store.js";
import { ConfigStore } from "../src/config/store.js";

const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64"));

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const cleanup: string[] = [];

afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

const fields = (name: string) => ({ ...blankRoleCardText(name), identity: "介绍" });

const CARDS = "data/yesimbot/characters";

async function fixture(extra: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "yesimbot-cards-"));
  cleanup.push(dir);
  const path = "~yesimbot-roleplay:one";
  const loader = {
    writable: true,
    config: { plugins: { [path]: { characterCard: "first", ...extra } } },
    isTruthyLike: (v: unknown) => v !== false,
    writeConfig: vi.fn(async () => {}),
  };
  const store = new ConfigStore({ baseDir: dir, loader } as never);
  await mkdir(join(dir, CARDS, "first"), { recursive: true });
  await writeFile(join(dir, CARDS, "first", "card.json"), JSON.stringify({ ...fields("第一张"), pictures: {} }));
  const cards = new CharacterCards(store);
  return {
    dir,
    path,
    loader,
    store,
    cards,
    snapshot: () => cards.snapshot(path),
    mutate: (action: "save" | "create" | "switch" | "remove" | "picture", input: Record<string, unknown>) =>
      cards.mutate(store.revision(), path, action, input),
  };
}

it("reads the default card and saves every box in place, leaving the config alone", async () => {
  const f = await fixture({ keep: "x" });
  const before = await f.snapshot();
  expect(before.selected).toMatchObject({ id: "first", fields: fields("第一张"), pictures: {} });
  const after = await f.mutate("save", {
    id: "first",
    etag: before.selected!.etag,
    fields: { ...before.selected!.fields, rules: "不说自己是 AI", identity: "" },
  });
  expect(after.active).toBe("first");
  expect((await readRoleCard(f.dir, "first")).card).toMatchObject({ rules: "不说自己是 AI", identity: "" });
  expect(after.selected!.etag).not.toBe(before.selected!.etag);
  expect(f.loader.writeConfig).not.toHaveBeenCalled();
  expect(f.loader.config.plugins[f.path]).toHaveProperty("keep", "x");
  // Only the card's own boxes are accepted.
  await expect(f.mutate("save", { id: "first", etag: after.selected!.etag, fields: { ...fields("x"), first_mes: "你好" } })).rejects.toMatchObject({
    code: "invalid_card",
  });
  await expect(f.mutate("save", { id: "first", etag: after.selected!.etag, fields: { name: "x".repeat(201) } })).rejects.toMatchObject({
    code: "invalid_card",
  });
});

it("creates cards in their own directory, switches the default and deletes the others", async () => {
  const f = await fixture();
  const created = await f.mutate("create", { fields: fields("第二张") });
  expect(created.cards.map((card) => card.name)).toEqual(["第一张", "第二张"]);
  expect(created.active).toBe("first");
  const id = created.selected!.id;
  expect((await readRoleCard(f.dir, id)).card).toEqual({ ...fields("第二张"), pictures: {} });
  const switched = await f.mutate("switch", { id });
  expect(switched.selected!.fields.name).toBe("第二张");
  expect(switched.active).toBe(id);
  await expect(f.mutate("remove", { id })).rejects.toMatchObject({ code: "active_card" });
  const removed = await f.mutate("remove", { id: "first" });
  expect(removed.cards.map((card) => card.id)).toEqual([id]);
  expect(await readdir(join(f.dir, CARDS))).toEqual([id]);
});

it("adds a copy of a built-in card, pictures included, and refuses a preset that does not exist", async () => {
  // User, 2026-11-27: 「将当前的anon角色卡作为系统内置的可选角色卡之一」.
  const f = await fixture();
  expect((await f.snapshot()).presets).toContainEqual({ id: "chihaya-anon", name: "千早爱音" });
  const added = await f.mutate("create", { preset: "chihaya-anon" });
  expect(added.cards.map((card) => card.name)).toEqual(["第一张", "千早爱音"]);
  expect(added.active).toBe("first");
  expect(Object.keys(added.selected!.pictures).sort()).toEqual(["reference", "turnaround"]);
  const copy = await readRoleCard(f.dir, added.selected!.id);
  expect((await readdir(copy.dir)).sort()).toEqual(["card.json", copy.card.pictures.reference, copy.card.pictures.turnaround].sort());
  await expect(f.mutate("create", { preset: "missing" })).rejects.toMatchObject({ code: "card_not_found" });
  expect((await f.snapshot()).cards).toHaveLength(2);
});

it("makes the first card of an empty library the default", async () => {
  const f = await fixture({ characterCard: undefined });
  const created = await f.mutate("create", { fields: fields("第一张") });
  expect(created.active).toBe(created.selected!.id);
});

it("rejects stale card and config edits, including competing saves with an unchanged config revision", async () => {
  const f = await fixture();
  const snapshot = await f.snapshot();
  await f.mutate("save", { id: "first", etag: snapshot.selected!.etag, fields: fields("第一个写入") });
  await expect(f.mutate("save", { id: "first", etag: snapshot.selected!.etag, fields: fields("旧页面") })).rejects.toMatchObject({ code: "card_changed" });
  await expect(f.cards.mutate("stale", f.path, "switch", { id: "first" })).rejects.toMatchObject({ code: "config_changed" });
  expect((await readRoleCard(f.dir, "first")).card.name).toBe("第一个写入");
});

it("puts the config back and removes a created card again when the config cannot be written", async () => {
  const f = await fixture();
  f.loader.writeConfig.mockRejectedValueOnce(new Error("failed"));
  await expect(f.mutate("create", { fields: fields("不能生效") })).rejects.toMatchObject({ code: "card_apply_failed", restored: true });
  expect(await readdir(join(f.dir, CARDS))).toEqual(["first"]);
  expect((await f.snapshot()).cards).toHaveLength(1);
  const second = await f.mutate("create", { fields: fields("第二张") });
  f.loader.writeConfig.mockRejectedValueOnce(new Error("failed"));
  await expect(f.mutate("switch", { id: second.selected!.id })).rejects.toMatchObject({ code: "card_apply_failed", restored: true });
  expect((await f.snapshot()).active).toBe("first");
});

it("lists only ids that are plain names, and reports a card it cannot read", async () => {
  const f = await fixture({ characterCards: ["first", "../outside", "broken", "a/b"] });
  await mkdir(join(f.dir, CARDS, "broken"));
  await writeFile(join(f.dir, CARDS, "broken", "card.json"), "{");
  const snapshot = await f.snapshot();
  expect(snapshot.cards.map((card) => [card.id, card.error ?? false])).toEqual([
    ["first", false],
    ["broken", true],
  ]);
  await expect(f.mutate("switch", { id: "../outside" })).rejects.toMatchObject({ code: "card_not_found" });
  await expect(f.cards.snapshot("~yesimbot:core")).rejects.toBeDefined();
});

it("serializes competing selections and rejects the stale request", async () => {
  const f = await fixture();
  const a = await f.mutate("create", { fields: fields("A") });
  const b = await f.mutate("create", { fields: fields("B") });
  const revision = f.store.revision();
  const results = await Promise.allSettled([
    f.cards.mutate(revision, f.path, "switch", { id: a.selected!.id }),
    f.cards.mutate(revision, f.path, "switch", { id: b.selected!.id }),
  ]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  expect((await f.snapshot()).active).toBe(a.selected!.id);
});

it("scopes every read and mutation to the granted plugin and writable instance", async () => {
  const f = await fixture();
  f.loader.writable = false;
  await expect(f.mutate("create", { fields: fields("不能写") })).rejects.toMatchObject({ code: "not_permitted" });
  f.loader.writable = true;
  vi.spyOn(f.store, "permitted").mockReturnValue(false);
  await expect(f.snapshot()).rejects.toMatchObject({ code: "not_permitted" });
  await expect(f.mutate("create", { fields: fields("不能写") })).rejects.toMatchObject({ code: "not_permitted" });
});

it("stores 参考图 and 三视图 beside the card, keeps them through text saves, serves and removes them", async () => {
  const f = await fixture();
  const before = await f.snapshot();
  await expect(f.cards.picture(f.path, "first", "reference")).rejects.toMatchObject({ code: "picture_not_found" });
  const set = await f.mutate("picture", { id: "first", etag: before.selected!.etag, key: "reference", picture: { bytes: JPEG, mediaType: "image/jpeg" } });
  const reference = set.selected!.pictures.reference!;
  expect(reference).toMatch(/^reference-[0-9a-f]{16}\.jpg$/);
  expect(set.cards[0]!.pictures).toEqual({ reference });
  await expect(f.cards.picture(f.path, "first", "reference")).resolves.toEqual({ bytes: Buffer.from(JPEG), mediaType: "image/jpeg", etag: reference });
  // A stale etag is refused; a text save keeps the pictures.
  await expect(f.mutate("picture", { id: "first", etag: before.selected!.etag, key: "reference", picture: null })).rejects.toMatchObject({
    code: "card_changed",
  });
  const both = await f.mutate("picture", { id: "first", etag: set.selected!.etag, key: "turnaround", picture: { bytes: PNG, mediaType: "image/png" } });
  const saved = await f.mutate("save", { id: "first", etag: both.selected!.etag, fields: { ...both.selected!.fields, identity: "新介绍" } });
  expect(saved.selected!.pictures).toEqual({ reference, turnaround: both.selected!.pictures.turnaround });
  await expect(f.mutate("picture", { id: "first", etag: saved.selected!.etag, key: "avatar", picture: null })).rejects.toMatchObject({
    code: "invalid_picture",
  });
  const removed = await f.mutate("picture", { id: "first", etag: saved.selected!.etag, key: "reference", picture: null });
  expect(removed.selected!.pictures).toEqual({ turnaround: both.selected!.pictures.turnaround });
  expect((await readdir(join(f.dir, CARDS, "first"))).sort()).toEqual(["card.json", both.selected!.pictures.turnaround!].sort());
  await expect(f.cards.picture(f.path, "first", "reference")).rejects.toMatchObject({ code: "picture_not_found" });
  expect(JSON.parse(await readFile(join(f.dir, CARDS, "first", "card.json"), "utf8")).identity).toBe("新介绍");
});
