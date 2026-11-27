import type { AgentPlugin } from "@yesimbot/agent-runtime";
import { editRoleCard, readRoleCard, readRoleCardPicture, writeRoleCardEdit, type StoredRoleCard } from "@yesimbot/character-cards";
import { ROLE_CARD_PICTURES, ROLE_CARD_TEXT_KEYS, type RoleCardPictureKey } from "@yesimbot/contracts/role-cards";
import { AppError, errorFields, logger } from "@yesimbot/foundation";
import type { CoreService } from "koishi-plugin-yesimbot/kernel";
import { protectPluginTools, RESOURCE_ERRORS, resourceError } from "koishi-plugin-yesimbot/kernel";
import type { ChannelContext, ChannelResources, MainAgentRoleProfile, MainAgentRoleProvider, ChatAccount } from "koishi-plugin-yesimbot/kernel";

import type { Config } from "./config.js";
import { ROLE_CARD_ERRORS } from "./errors.js";
import { createUpdateRoleCardTool, updateRoleCardFailure, type OwnCardUpdate, type UpdateRoleCardResult } from "./own-card.js";
import { assembleRoleProfile } from "./prompt.js";
import { ROLE_PICTURE_URIS, ROLE_PICTURES_SCHEME_PROMPT, rolePicturesPrompt } from "./visual-reference.js";

export const ROLEPLAY_PLUGIN_NAME = "yesimbot-roleplay";

const log = logger("yesimbot.roleplay");

/** What roleplay needs from Core's service. */
export type RoleplayHost = Pick<CoreService, "agent" | "overrides" | "resource">;

interface LoadedCard {
  readonly stored: StoredRoleCard;
  /** The card as Core places it, pictures included; built once per load. */
  readonly profile: MainAgentRoleProfile;
}

/** Role cards: the main Agent's role profile, `role://self/…` pictures and the bot's own card edits. */
export class Roleplay {
  public readonly name = ROLEPLAY_PLUGIN_NAME;
  public readonly roleProfile: MainAgentRoleProvider = { resolve: (scope) => this.resolve(scope) };
  private loadGeneration = 0;
  /** The configured default card. */
  private active?: LoadedCard;
  /** Every card in the library by id, for conversations that chose one. */
  private readonly library = new Map<string, LoadedCard>();
  private disposeAgentPlugin: (() => void) | undefined;
  private disposeReader: (() => void) | undefined;
  /** Which conversation a ChannelResources belongs to, so a picture is read only where its card speaks. */
  private readonly bindings = new WeakMap<ChannelResources, ChannelContext>();
  /** The bot's own card edits, one at a time. */
  private edits: Promise<unknown> = Promise.resolve();

  /** Cards live under `baseDir` (the state directory). */
  public constructor(
    private readonly host: RoleplayHost,
    public readonly config: Config,
    private readonly baseDir: string,
  ) {}

  public async start(): Promise<void> {
    const generation = ++this.loadGeneration;
    this.disposeAgentPlugin?.();
    this.disposeAgentPlugin = undefined;
    this.disposeReader?.();
    this.disposeReader = undefined;

    const active = this.config.characterCard?.trim();
    const loaded = new Map<string, LoadedCard>();
    // The whole library loads up front: a conversation can switch to any card without waiting.
    for (const id of new Set([active, ...(this.config.characterCards ?? []).map((item) => item?.trim())].filter((item): item is string => !!item))) {
      try {
        const stored = await readRoleCard(this.baseDir, id);
        const profile = assembleRoleProfile(stored.card);
        const pictures = rolePicturesPrompt(stored.card.pictures);
        loaded.set(id, {
          stored,
          profile: pictures ? { ...profile, roleInstructions: [profile.roleInstructions, pictures].filter(Boolean).join("\n\n") } : profile,
        });
      } catch (cause) {
        log.warn("roleplay.card_skipped", { card: id, ...errorFields(cause) });
      }
    }
    if (generation !== this.loadGeneration) return;
    this.library.clear();
    for (const [id, card] of loaded) this.library.set(id, card);
    this.active = active ? loaded.get(active) : undefined;
    if (!this.active) log.warn("roleplay.no_character");
    if ([...loaded.values()].some((card) => Object.keys(card.stored.card.pictures).length)) {
      this.disposeReader = this.host.resource.use({
        scheme: "role",
        prompt: ROLE_PICTURES_SCHEME_PROMPT,
        setup: async (resources, uri) => this.openPicture(resources, uri),
      });
    }
    if (loaded.size) this.disposeAgentPlugin = this.host.agent.use(this);
  }

  /** Card resolution for the main Agent; Core places it once in its continuous role section. */
  public resolve(scope: ChannelContext): MainAgentRoleProfile | undefined {
    return this.cardFor(scope)?.profile;
  }

  /** Binds the conversation's resources (for `role://` and the card edit tool) before building its plugin. */
  public async setup(scope: ChannelContext, _bot: ChatAccount): Promise<AgentPlugin> {
    const resources = await this.host.resource.get(scope);
    this.bindings.set(resources, scope);
    // This conversation chose no role card: the default persona speaks.
    if (!this.cardFor(scope)) return { name: "roleplay" };
    // Reloading re-registers the role, and that retires every runtime built before it, the running turn's replies
    // included (Core's `replyStillCurrent`; user, 2026-11-27: 「现在让bot改角色卡后，似乎发送消息会被拦截」). So an edit
    // takes effect when the turn that made it ends (done, aborted or failed), not when another conversation's turn does.
    let edited = false;
    const update = async (change: OwnCardUpdate) => {
      const result = await this.updateOwnCard(scope, change);
      if (result.ok) edited = true;
      return result;
    };
    const plugin: AgentPlugin = {
      name: "roleplay",
      tools: () => [createUpdateRoleCardTool({ resources, update })],
      onTurnFinish: async () => {
        if (!edited) return;
        edited = false;
        await this.start();
      },
    };
    // The capability table makes the edit tool sensitive and direct-only: the owner's private chat.
    return protectPluginTools(plugin, { platform: scope.platform, kind: scope.type === "direct" ? "direct" : "group" }, ROLEPLAY_PLUGIN_NAME);
  }

  public async stop(): Promise<void> {
    this.loadGeneration += 1;
    this.disposeAgentPlugin?.();
    this.disposeAgentPlugin = undefined;
    this.disposeReader?.();
    this.disposeReader = undefined;
  }

  /** A picture of the card this conversation speaks with, read when asked for. */
  private async openPicture(resources: ChannelResources, uri: URL) {
    const key = (Object.keys(ROLE_PICTURE_URIS) as RoleCardPictureKey[]).find((item) => ROLE_PICTURE_URIS[item] === uri.href);
    if (!key) throw resourceError(RESOURCE_ERRORS.resource_not_found);
    const scope = this.bindings.get(resources);
    const card = scope && this.cardFor(scope);
    let picture;
    try {
      picture = card && (await readRoleCardPicture(card.stored, key));
    } catch (cause) {
      log.warn("roleplay.picture_unreadable", { card: card?.stored.id, picture: key, ...errorFields(cause) });
    }
    if (!picture) throw resourceError(RESOURCE_ERRORS.resource_unavailable);
    const extension = picture.mediaType === "image/jpeg" ? "jpg" : picture.mediaType.slice("image/".length);
    return { ...picture, filename: `${key === "reference" ? "appearance" : key}.${extension}` };
  }

  /** The bot's edit of the card this conversation speaks with; the next message uses it. */
  private updateOwnCard(scope: ChannelContext, change: OwnCardUpdate): Promise<UpdateRoleCardResult> {
    const run = this.edits.then(async (): Promise<UpdateRoleCardResult> => {
      const loaded = this.cardFor(scope);
      let stored: StoredRoleCard;
      try {
        if (!loaded) throw new AppError(ROLE_CARD_ERRORS.role_card_unavailable, { effect: "none" });
        stored = await readRoleCard(this.baseDir, loaded.stored.id);
      } catch (cause) {
        log.warn("roleplay.own_card_unreadable", { card: loaded?.stored.id, ...errorFields(cause) });
        return updateRoleCardFailure(ROLE_CARD_ERRORS.role_card_unavailable, cause);
      }
      const edit = editRoleCard(stored.card, change.text, change.pictures);
      const changed = [
        ...ROLE_CARD_TEXT_KEYS.filter((key) => edit.card[key] !== stored.card[key]),
        ...ROLE_CARD_PICTURES.map(({ key }) => key).filter((key) => edit.card.pictures[key] !== stored.card.pictures[key]),
      ];
      if (!changed.length) return updateRoleCardFailure(ROLE_CARD_ERRORS.role_card_unchanged);
      try {
        // The console may have saved the card meanwhile; never overwrite that.
        await writeRoleCardEdit(stored, edit);
      } catch (cause) {
        if (cause instanceof AppError && cause.code === "file_changed") return updateRoleCardFailure(ROLE_CARD_ERRORS.role_card_changed, cause);
        log.warn("roleplay.own_card_write_failed", { card: stored.id, ...errorFields(cause) });
        return updateRoleCardFailure(ROLE_CARD_ERRORS.role_card_unavailable, cause);
      }
      log.info("roleplay.own_card_updated", { card: stored.id, changed });
      // The role reloads when this turn ends (`setup`); each conversation takes the new card with its next message.
      return { ok: true, changed, note: "从下一条消息起生效。" };
    });
    this.edits = run.catch(() => {});
    return run;
  }

  /**
   * The card this conversation speaks with: its own choice (a library card, or "" for none) when it
   * made one that still exists, otherwise the default card.
   */
  private cardFor(scope: ChannelContext): LoadedCard | undefined {
    const chosen = this.host.overrides?.get(scope)?.roleCard;
    if (chosen === "") return undefined;
    return (chosen !== undefined && this.library.get(chosen)) || this.active;
  }
}
