import { computed, getCurrentScope, onScopeDispose, watch } from "vue";

import type { PluginConfigEntry, PluginsSnapshot } from "../../../src/shared/plugin-config";
import { ABILITIES, abilityIssue, type Ability } from "../lib/abilities";
import { flattenPlugins } from "../lib/plugin-config";
import { useTopic } from "../lib/use-topic";
import { createGoogleConnections } from "./google-connections";

/**
 * What needs the owner on 能力 (user, 2026-11-21: 出问题的自己冒出来): a failed or unconfigured capability, and
 * Google's own state (no app, no account, an expired authorization). Shared by the page and its dot in the settings list.
 */
export function useAbilityIssues() {
  const plugins = useTopic<PluginsSnapshot>("plugins");
  const entries = computed(() => flattenPlugins(plugins.data?.tree ?? []).filter((entry) => !entry.group));
  const entryOf = (name: string): PluginConfigEntry | undefined => entries.value.find((entry) => entry.name === name);
  const google = createGoogleConnections();
  if (getCurrentScope()) onScopeDispose(google.dispose);
  watch(
    () => entryOf("yesimbot-google")?.enabled,
    (enabled) => {
      if (enabled && !google.state.snapshot && !google.state.loading) void google.load();
    },
    { immediate: true },
  );
  const issueOf = (ability: Ability) => abilityIssue(ability, entryOf(ability.plugin), google.state.snapshot);
  const count = computed(() => ABILITIES.filter((ability) => issueOf(ability)).length);
  return { plugins, entries, entryOf, issueOf, count };
}
