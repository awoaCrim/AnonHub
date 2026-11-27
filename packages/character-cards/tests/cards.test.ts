import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { blankRoleCardText, type RoleCard } from "@yesimbot/contracts/role-cards";
import { afterEach, expect, it } from "vitest";

import {
  createRoleCard,
  decodeRoleCard,
  deleteRoleCard,
  editRoleCard,
  encodeRoleCard,
  isRoleCardId,
  listRoleCardPresets,
  readRoleCard,
  readRoleCardPicture,
  readRoleCardPreset,
  roleCardPictureType,
  writeRoleCardEdit,
} from "../src/index.js";

const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64"));

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);

const roots: string[] = [];

async function state() {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-cards-"));
  roots.push(root);
  return root;
}

const card = (name = "爱音"): RoleCard => ({ ...blankRoleCardText(name), pictures: {} });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("reads only cards in the current format", () => {
  expect(decodeRoleCard(Buffer.from(encodeRoleCard(card())))).toEqual(card());
  for (const bad of ["{", "[]", JSON.stringify({ ...card(), extra: 1 }), JSON.stringify({ ...card(), first_mes: "你好" }), JSON.stringify({ name: "爱音" })])
    expect(() => decodeRoleCard(Buffer.from(bad))).toThrow(expect.objectContaining({ code: "role_card_invalid" }));
  expect(() => decodeRoleCard(Buffer.from(JSON.stringify({ ...card(), pictures: { reference: "../x.png" } })))).toThrow();
});

it("names pictures by content: a new picture is added and the replaced one goes, the same picture is no change", () => {
  const first = editRoleCard(card(), { identity: "高一学生" }, { reference: { bytes: PNG, mediaType: "image/png" } });
  expect(first.card).toMatchObject({ identity: "高一学生", pictures: { reference: expect.stringMatching(/^reference-[0-9a-f]{16}\.png$/) } });
  expect(first.added).toEqual([{ file: first.card.pictures.reference, bytes: PNG }]);
  expect(first.removed).toEqual([]);
  expect(editRoleCard(first.card, {}, { reference: { bytes: PNG, mediaType: "image/png" } })).toEqual({ card: first.card, added: [], removed: [] });
  const replaced = editRoleCard(first.card, {}, { reference: { bytes: JPEG, mediaType: "image/jpeg" }, turnaround: null });
  expect(replaced.card.pictures.reference).toMatch(/\.jpg$/);
  expect(replaced.removed).toEqual([first.card.pictures.reference]);
  expect(editRoleCard(first.card, {}, { reference: null })).toEqual({
    card: { ...first.card, pictures: {} },
    added: [],
    removed: [first.card.pictures.reference],
  });
});

it("creates, edits under its read content and deletes a card in its own directory", async () => {
  const root = await state();
  await createRoleCard(root, "abc", card());
  await expect(createRoleCard(root, "abc", card("别人"))).rejects.toThrow();
  const stored = await readRoleCard(root, "abc");
  expect(stored.card).toEqual(card());
  const edit = editRoleCard(stored.card, { rules: "不说自己是 AI" }, { turnaround: { bytes: PNG, mediaType: "image/png" } });
  await writeRoleCardEdit(stored, edit);
  const after = await readRoleCard(root, "abc");
  expect(after.card).toEqual(edit.card);
  await expect(readRoleCardPicture(after, "turnaround")).resolves.toEqual({ bytes: Buffer.from(PNG), mediaType: "image/png" });
  await expect(readRoleCardPicture(after, "reference")).resolves.toBeUndefined();
  // A writer holding what it read before the change is refused, and nothing it would have removed goes.
  await expect(writeRoleCardEdit(stored, editRoleCard(stored.card, { rules: "过时的" }))).rejects.toMatchObject({ code: "file_changed" });
  expect((await readRoleCard(root, "abc")).card.rules).toBe("不说自己是 AI");
  await deleteRoleCard(root, "abc");
  await expect(readdir(join(root, "data/yesimbot/characters"))).resolves.toEqual([]);
});

it("refuses ids that are not plain names, symlinks, and a picture whose content does not match its name", async () => {
  for (const id of ["", "../x", "a/b", "a.b", "x".repeat(65)]) expect(isRoleCardId(id)).toBe(false);
  expect(isRoleCardId("Ab_9-z")).toBe(true);
  const root = await state();
  await expect(readRoleCard(root, "../outside")).rejects.toMatchObject({ code: "role_card_invalid" });
  await createRoleCard(root, "abc", card());
  const stored = await readRoleCard(root, "abc");
  const edit = editRoleCard(stored.card, {}, { reference: { bytes: PNG, mediaType: "image/png" } });
  await writeRoleCardEdit(stored, edit);
  await writeFile(join(stored.dir, edit.card.pictures.reference!), JPEG);
  await expect(readRoleCardPicture({ dir: stored.dir, card: edit.card }, "reference")).rejects.toMatchObject({ code: "role_card_invalid" });
  const outside = join(await state(), "card.json");
  await writeFile(outside, await readFile(join(stored.dir, "card.json")));
  await rm(join(stored.dir, "card.json"));
  await symlink(outside, join(stored.dir, "card.json"));
  await expect(readRoleCard(root, "abc")).rejects.toThrow();
});

it("keeps PNG, JPEG and WebP pictures within 5 MB only", () => {
  expect(roleCardPictureType(PNG)).toBe("image/png");
  expect(roleCardPictureType(JPEG)).toBe("image/jpeg");
  expect(roleCardPictureType(new TextEncoder().encode("GIF89a"))).toBeUndefined();
  const large = new Uint8Array(5 * 1024 * 1024 + 1);
  large.set(PNG);
  expect(roleCardPictureType(large)).toBeUndefined();
});

it("ships 千早爱音 as a preset a library copies, pictures included", async () => {
  // User, 2026-11-27: 「将当前的anon角色卡作为系统内置的可选角色卡之一」.
  expect(await listRoleCardPresets()).toContainEqual({ id: "chihaya-anon", name: "千早爱音" });
  const root = await state();
  const preset = await readRoleCardPreset("chihaya-anon");
  await createRoleCard(root, "copy", preset.card, preset.files);
  const stored = await readRoleCard(root, "copy");
  expect(stored.card).toEqual(preset.card);
  for (const key of ["reference", "turnaround"] as const) expect((await readRoleCardPicture(stored, key))?.mediaType).toBe("image/jpeg");
  await expect(readRoleCardPreset("missing")).rejects.toThrow();
  await expect(readRoleCardPreset("../outside")).rejects.toThrow();
});
