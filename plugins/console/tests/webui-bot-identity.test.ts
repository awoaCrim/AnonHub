import { afterEach, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";

import type { CardsSnapshot } from "../src/shared/character-cards";
import type { PluginsSnapshot } from "../src/shared/plugin-config";
import { useBotIdentity } from "../web/src/shell/bot-identity";

const settle = async () => {
  for (let index = 0; index < 5; index++) await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const entry = (key: string, enabled = true) => ({
  key,
  name: key.replace(/^~/, "").split(":")[0]!,
  label: key,
  path: key,
  group: false,
  enabled,
  status: enabled ? "active" : "disabled",
  locked: false,
  needsConfig: false,
});
const snapshot = (revision: string, tree: ReturnType<typeof entry>[]) => ({ revision, writable: true, tree, available: [] }) as unknown as PluginsSnapshot;
const cards = (active: string, list: Partial<CardsSnapshot["cards"][number]>[]): CardsSnapshot =>
  ({ revision: "r", active, cards: list }) as unknown as CardsSnapshot;

afterEach(() => vi.unstubAllGlobals());

it("names the bot after the active role card and rereads it only when the configuration changes", async () => {
  let reply = cards("a", [
    { id: "a", name: "千早爱音", pictures: { reference: "reference-0123456789abcdef.png", turnaround: "turnaround-fedcba9876543210.png" } },
    { id: "b", name: "别的角色", pictures: { reference: "reference-1111111111111111.png" } },
  ]);
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      calls.push(String(input));
      return new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } });
    }),
  );
  const plugins = reactive({ state: { data: snapshot("1", [entry("yesimbot-roleplay:r1"), entry("yesimbot")]) as PluginsSnapshot | undefined } });
  const bot = useBotIdentity(plugins);
  await settle();
  expect(bot.value).toEqual({
    name: "千早爱音",
    image: "/yesimbot/api/v1/characters/picture?path=yesimbot-roleplay%3Ar1&id=a&key=reference&v=reference-0123456789abcdef.png",
  });
  expect(calls).toEqual(["/yesimbot/api/v1/characters?path=yesimbot-roleplay%3Ar1"]);

  // Switching the active card is a configuration change: the sidebar follows it.
  // A card with only a 三视图 has no avatar: the avatar is the 参考图.
  reply = cards("b", [{ id: "b", name: "别的角色", pictures: { turnaround: "turnaround-1111111111111111.png" } }]);
  plugins.state.data = snapshot("2", [entry("yesimbot-roleplay:r1"), entry("yesimbot")]);
  await settle();
  expect(bot.value).toEqual({ name: "别的角色", image: undefined });
  expect(calls).toHaveLength(2);

  // Roleplay off: a plain name, no request.
  plugins.state.data = snapshot("3", [entry("~yesimbot-roleplay:r1", false), entry("yesimbot")]);
  await settle();
  expect(bot.value).toEqual({ name: "我的 bot" });
  expect(calls).toHaveLength(2);
});

it("keeps the plain name when the card list cannot be read or has no usable active card", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ message: "apply_failed" }), { status: 503, headers: { "content-type": "application/json" } })),
  );
  const plugins = reactive({ state: { data: snapshot("1", [entry("yesimbot-roleplay:r1")]) as PluginsSnapshot | undefined } });
  const bot = useBotIdentity(plugins);
  await settle();
  expect(bot.value).toEqual({ name: "我的 bot" });

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(cards("x", [{ id: "x", name: "坏卡", error: true }])), { headers: { "content-type": "application/json" } })),
  );
  plugins.state.data = snapshot("2", [entry("yesimbot-roleplay:r1")]);
  await settle();
  expect(bot.value).toEqual({ name: "我的 bot" });
});
