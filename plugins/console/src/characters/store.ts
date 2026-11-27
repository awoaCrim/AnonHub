import {
  createRoleCard,
  deleteRoleCard,
  editRoleCard,
  isRoleCardId,
  listRoleCardPresets,
  readRoleCard,
  readRoleCardPicture,
  readRoleCardPreset,
  writeRoleCardEdit,
  type RoleCardPicture,
} from "@yesimbot/character-cards";
import { blankRoleCardText, roleCardTextSchema, type RoleCardPictureKey } from "@yesimbot/contracts/role-cards";
import { AppError, contentHash, newId } from "@yesimbot/foundation";

import { ConfigError, ConfigStore } from "../config/store.js";
import type { CardsSnapshot } from "../shared/character-cards.js";
import { pluginBaseName } from "../shared/plugin-catalog.js";

const MAX_CARDS = 100;

export type CardAction = "save" | "create" | "switch" | "remove" | "picture";

type Config = Record<string, unknown>;

export class CardError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly restored?: boolean,
    options?: { cause?: unknown },
  ) {
    super(code, options);
  }
}

/**
 * Per-runtime library: the roleplay config owns which cards are in it and which one is the default, each card's
 * directory owns its content (`@yesimbot/character-cards`). A card's etag is the hash of its card.json, which also
 * names its pictures, so any change to the card changes it.
 */
export class CharacterCards {
  constructor(readonly config: ConfigStore) {}

  /** A picture of a listed card. */
  async picture(path: string, id: string, key: RoleCardPictureKey): Promise<RoleCardPicture & { etag: string }> {
    if (!this.ids(this.entry(path).value).includes(id)) throw new CardError(404, "card_not_found");
    const stored = await this.read(id);
    const picture = await readRoleCardPicture(stored, key).catch(() => undefined);
    if (!picture) throw new CardError(404, "picture_not_found");
    return { ...picture, etag: stored.card.pictures[key]! };
  }

  async snapshot(path: string, selected?: string): Promise<CardsSnapshot> {
    const revision = this.config.revision(),
      value = structuredClone(this.entry(path).value);
    const active = typeof value.characterCard === "string" ? value.characterCard : "";
    const cards: CardsSnapshot["cards"] = [];
    let selection: CardsSnapshot["selected"];
    const wanted = selected ?? active;
    for (const id of this.ids(value)) {
      try {
        const { bytes, card } = await this.read(id);
        const { pictures, ...fields } = card;
        const etag = contentHash(bytes);
        cards.push({ id, name: card.name || "未命名角色", fields, pictures, etag });
        if (id === wanted) selection = { id, fields, pictures, etag };
      } catch {
        cards.push({ id, name: "无法读取角色卡", error: true });
      }
    }
    const presets = await listRoleCardPresets();
    if (this.config.revision() !== revision) throw new ConfigError(409, "config_changed");
    return { revision, active, cards, selected: selection, presets };
  }

  /**
   * One change to the library. A card's own text or picture is written under its etag; adding, removing or choosing
   * the default card changes the config in the same transaction. `create` with `preset` adds a copy of that preset.
   */
  async mutate(revision: string, path: string, action: CardAction, input: Record<string, unknown>): Promise<CardsSnapshot> {
    return this.config.transaction(revision, async () => {
      const value = structuredClone(this.entry(path).value);
      const ids = this.ids(value);
      const id = typeof input.id === "string" ? input.id : "";
      const active = typeof value.characterCard === "string" ? value.characterCard : "";
      if (action !== "create" && !ids.includes(id)) throw new CardError(404, "card_not_found");
      if (action === "save" || action === "picture") {
        const stored = await this.read(id);
        if (typeof input.etag !== "string" || contentHash(stored.bytes) !== input.etag) throw new CardError(409, "card_changed");
        const edit =
          action === "save"
            ? editRoleCard(stored.card, this.text(input.fields))
            : editRoleCard(stored.card, {}, { [this.pictureKey(input.key)]: (input.picture as RoleCardPicture | null) ?? null });
        await this.write(() => writeRoleCardEdit(stored, edit));
        return this.snapshot(path, id);
      }
      if (action === "create") {
        if (ids.length >= MAX_CARDS) throw new CardError(400, "too_many_cards");
        const created = newId();
        const preset = input.preset === undefined ? undefined : await this.preset(input.preset);
        await this.write(() =>
          preset
            ? createRoleCard(this.config.ctx.baseDir, created, preset.card, preset.files)
            : createRoleCard(this.config.ctx.baseDir, created, { ...this.text(input.fields), pictures: {} }),
        );
        value.characterCards = [...ids, created];
        if (!active) value.characterCard = created;
        await this.apply(path, value, () => deleteRoleCard(this.config.ctx.baseDir, created));
        return this.snapshot(path, created);
      }
      if (action === "switch") {
        value.characterCards = ids;
        value.characterCard = id;
        await this.apply(path, value);
        return this.snapshot(path, id);
      }
      if (id === active) throw new CardError(409, "active_card");
      value.characterCards = ids.filter((item) => item !== id);
      await this.apply(path, value);
      // The library no longer names it; a card that cannot be deleted now is only a leftover directory.
      await deleteRoleCard(this.config.ctx.baseDir, id).catch(() => undefined);
      return this.snapshot(path, active);
    });
  }

  private entry(path: string) {
    const entry = this.config.resolve(path);
    if (pluginBaseName(entry.key) !== "yesimbot-roleplay" || this.config.locked(entry.value, entry.key)) throw new ConfigError(403, "not_permitted");
    return entry;
  }

  private ids(config: Config): string[] {
    const values = [config.characterCard, ...(Array.isArray(config.characterCards) ? config.characterCards : [])];
    return [...new Set(values.filter(isRoleCardId))].slice(0, MAX_CARDS);
  }

  private async read(id: string) {
    try {
      return await readRoleCard(this.config.ctx.baseDir, id);
    } catch (error) {
      throw new CardError(error instanceof AppError && error.code === "path_missing" ? 404 : 400, "invalid_card", undefined, { cause: error });
    }
  }

  private async preset(id: unknown) {
    try {
      return await readRoleCardPreset(String(id));
    } catch (error) {
      throw new CardError(404, "card_not_found", undefined, { cause: error });
    }
  }

  /** The editor sends every box: a full replacement, where an empty string clears one. */
  private text(value: unknown) {
    const parsed = roleCardTextSchema.safeParse({ ...blankRoleCardText(), ...(value && typeof value === "object" ? value : {}) });
    if (!parsed.success) throw new CardError(400, "invalid_card");
    return parsed.data;
  }

  private pictureKey(value: unknown): RoleCardPictureKey {
    if (value !== "reference" && value !== "turnaround") throw new CardError(400, "invalid_picture");
    return value;
  }

  private async write(run: () => Promise<unknown>) {
    try {
      await run();
    } catch (error) {
      if (error instanceof AppError && error.code === "file_changed") throw new CardError(409, "card_changed", undefined, { cause: error });
      throw error;
    }
  }

  /**
   * Writes the roleplay config; on failure puts the earlier config back (unless someone else changed it meanwhile),
   * undoes `undo` (a card created for it) and reports whether both worked.
   */
  private async apply(path: string, value: Config, undo?: () => Promise<void>) {
    const before = structuredClone(this.entry(path).value);
    try {
      await this.config.updateRaw(path, value);
    } catch (error) {
      const current = JSON.stringify(this.entry(path).value);
      let restored = current === JSON.stringify(value) || current === JSON.stringify(before);
      if (restored) await this.config.updateRaw(path, before).catch(() => (restored = false));
      if (undo) await undo().catch(() => (restored = false));
      throw new CardError(503, "card_apply_failed", restored, { cause: error });
    }
  }
}
