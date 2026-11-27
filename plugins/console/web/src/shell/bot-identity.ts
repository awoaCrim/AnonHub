import type { RoleCardPictures } from "@yesimbot/contracts/role-cards";
import { computed, inject, ref, watch, type ComputedRef, type InjectionKey } from "vue";

import type { CardsSnapshot } from "../../../src/shared/character-cards";
import type { PluginsSnapshot } from "../../../src/shared/plugin-config";
import { api } from "../lib/api";
import { flattenPlugins } from "../lib/plugin-config";
import { cardPictureUrl } from "../state/role-editor";

export interface BotIdentity {
  name: string;
  /** The active role card's 参考图, when it has one. */
  image?: string;
  /** The bot's own account picture (its QQ avatar), shown where a card has no 参考图. */
  avatar?: string;
}

interface ActiveCard {
  path: string;
  id: string;
  name: string;
  pictures?: RoleCardPictures;
}

/**
 * Who the bot is, for the chat: the active role card's name and 参考图 while roleplay is on,
 * otherwise a plain 「我的 bot」. It rereads only when the plugin configuration changes (switching
 * the active card is a configuration change), never on a timer.
 */
export function useBotIdentity(
  plugins: { readonly state: { readonly data?: PluginsSnapshot } },
  panel?: { readonly data?: { adapters: readonly { avatar?: string; state: string }[] } | null },
) {
  // An online account's picture first; any known one otherwise.
  const avatar = computed(() => {
    const adapters = panel?.data?.adapters ?? [];
    return (adapters.find((adapter) => adapter.avatar && adapter.state === "online") ?? adapters.find((adapter) => adapter.avatar))?.avatar;
  });
  const roleplay = computed(() =>
    flattenPlugins(plugins.state.data?.tree ?? []).find((item) => !item.group && item.enabled && item.name === "yesimbot-roleplay"),
  );
  const card = ref<ActiveCard>();
  let generation = 0;
  watch(
    () => [roleplay.value?.path, plugins.state.data?.revision] as const,
    async ([path]) => {
      const token = ++generation;
      if (!path) {
        card.value = undefined;
        return;
      }
      try {
        const snapshot = await api<CardsSnapshot>(`/yesimbot/api/v1/characters?path=${encodeURIComponent(path)}`, undefined, { fresh: true });
        if (token !== generation) return;
        const active = snapshot.cards.find((item) => item.id === snapshot.active && !item.error);
        card.value = active && { path, id: active.id, name: active.name, pictures: active.pictures };
      } catch {
        // The sidebar keeps its plain name; the role page reports the error.
        if (token === generation) card.value = undefined;
      }
    },
    { immediate: true },
  );
  return computed<BotIdentity>(() => {
    const active = card.value;
    if (!active) return { name: "我的 bot", avatar: avatar.value };
    return { name: active.name.trim() || "我的 bot", image: cardPictureUrl(active.path, active), avatar: avatar.value };
  });
}

/** The shell provides its identity so pages show the same name and avatar without reading cards again. */
export const botIdentityKey: InjectionKey<ComputedRef<BotIdentity>> = Symbol("bot-identity");
export function injectBotIdentity(): ComputedRef<BotIdentity> {
  return inject(
    botIdentityKey,
    computed(() => ({ name: "我的 bot" })),
    false,
  );
}
