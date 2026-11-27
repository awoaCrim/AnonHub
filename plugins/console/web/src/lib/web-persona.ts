import { computed, ref, watch } from "vue";

import type { CardsSnapshot } from "../../../src/shared/character-cards";
import type { PluginsSnapshot } from "../../../src/shared/plugin-config";
import { injectBotIdentity, type BotIdentity } from "../shell/bot-identity";
import { cardPictureUrl } from "../state/role-editor";
import type { createWebChat } from "../state/web-chat";
import { api } from "./api";
import type { PickerOption } from "./picker";
import { flattenPlugins } from "./plugin-config";
import { toast } from "./toast";
import { useTopic } from "./use-topic";

/**
 * Who speaks in the open web conversation: its own role card, none, or the one from 设置. The chat's
 * header and the 对话 card read the same face and name from here, and the card's 角色 picks it.
 */
export function useWebPersona(chat: ReturnType<typeof createWebChat>) {
  const { state } = chat;
  const open = computed(() => state.snapshot?.conversations?.find((item) => item.id === state.snapshot?.conversation.id));

  const plugins = useTopic<PluginsSnapshot>("plugins");
  const roleplayPath = computed(
    () => flattenPlugins(plugins.data?.tree ?? []).find((item) => !item.group && item.enabled && item.name === "yesimbot-roleplay")?.path,
  );
  const library = ref<CardsSnapshot>();
  watch(
    () => [roleplayPath.value, plugins.data?.revision] as const,
    async ([path]) => {
      if (!path) return void (library.value = undefined);
      try {
        library.value = await api<CardsSnapshot>(`/yesimbot/api/v1/characters?path=${encodeURIComponent(path)}`, undefined, { fresh: true });
      } catch {
        // The picker keeps the last list; the chat does not depend on it.
      }
    },
    { immediate: true },
  );
  const cards = computed(() => (library.value?.cards ?? []).filter((card) => !card.error));
  const settingsCard = computed(() => library.value?.cards.find((card) => card.id === library.value?.active)?.name ?? "");

  /** A role can be picked only for a listed conversation, and only while role cards are on. */
  const canPick = computed(() => !!open.value && !!roleplayPath.value);
  const roleValue = computed({
    get: () => (open.value?.roleCard === undefined ? "@settings" : open.value.roleCard),
    set: (value: string) => {
      const conversation = open.value;
      if (!conversation) return;
      const name = value === "@settings" ? settingsCard.value || "设置里的角色" : value ? cards.value.find((card) => card.id === value)?.name : "";
      void chat.change({ action: "update", id: conversation.id, roleCard: value === "@settings" ? null : value }).then((error) => {
        if (error) toast(error, "danger");
        else toast(value === "" ? "这个对话之后不用角色卡。" : `这个对话之后由「${name}」说话。`);
      });
    },
  });
  const roleOptions = computed<PickerOption[]>(() => [
    { value: "@settings", label: "跟随设置", note: settingsCard.value },
    { value: "", label: "不用角色卡", note: "内置人设" },
    ...cards.value.map((card, index) => ({ value: card.id, label: card.name, divider: index === 0 })),
  ]);

  /** The face and name in this conversation follow its choice; elsewhere they follow 设置. */
  const settingsBot = injectBotIdentity();
  const bot = computed<BotIdentity>(() => {
    const chosen = open.value?.roleCard;
    if (chosen === undefined || !roleplayPath.value) return settingsBot.value;
    if (chosen === "") return { name: "AnonHub" };
    const card = cards.value.find((item) => item.id === chosen);
    if (!card) return settingsBot.value;
    return { name: card.name, image: cardPictureUrl(roleplayPath.value, card) };
  });

  return { roleplayPath, open, canPick, roleValue, roleOptions, bot, changing: computed(() => state.changing) };
}

export type WebPersona = ReturnType<typeof useWebPersona>;
