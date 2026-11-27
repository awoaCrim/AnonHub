import { directChannelId, PLATFORMS, WEB_CHAT } from "@yesimbot/contracts/platforms";
import type { Clock } from "@yesimbot/foundation";

import type { AdminAuth } from "../admin-auth.js";
import type { Host } from "../host.js";
import type { BotContacts, ContactEntry, ContactsResponse } from "../shared/contacts.js";
import { authorizeOwner } from "./plugins.js";

export const CONTACTS_PATH = "/yesimbot/api/v1/bot/contacts";
const MAX_PER_KIND = 2000;
const TIMEOUT_MS = 5_000;
const CACHE_MS = 60_000;
/** Koishi `Status.ONLINE`; not imported to keep this module free of runtime Koishi values. */
const ONLINE = 1;

/** Satori `Friend` (`{ user, nick }`); the OneBot adapter returns plain users instead. */
type FriendItem = UserLike & { user?: UserLike };

interface ListBot {
  platform: string;
  selfId: string;
  status: number;
  user?: { name?: string; nick?: string };
  getGuildList(next?: string): Promise<{ data: { id: string; name?: string }[]; next?: string }>;
  getFriendList(next?: string): Promise<{ data: FriendItem[]; next?: string }>;
}

interface UserLike {
  id?: string;
  name?: string;
  nick?: string;
}

/**
 * Groups and friends of the online chat accounts (every chat platform in the registry), for
 * choosing where the bot replies. A guild ID is used as its channel ID; a friend's direct
 * channel ID follows the platform (`private:` on QQ). Members reach their own runtime through
 * the tenant relay.
 */
export function installContacts(ctx: Host, auth: AdminAuth) {
  const cache = new Map<string, { at: number; value: Promise<BotContacts> }>();
  ctx.server.get(CONTACTS_PATH, async (http) => {
    if (!authorizeOwner(http, auth)) return;
    // The built-in web chat has no contacts and needs no reply rule; it never counts as an online chat account.
    const bots = (ctx.bots as unknown as ListBot[]).filter(
      (bot) => bot.platform !== WEB_CHAT.platform && PLATFORMS.some((platform) => platform.id === bot.platform) && bot.status === ONLINE,
    );
    if (!bots.length) {
      http.status = 503;
      http.body = { message: "bot_offline" };
      return;
    }
    const now = ctx.clock.now();
    http.body = {
      bots: await Promise.all(
        bots.map((bot) => {
          const key = `${bot.platform}:${bot.selfId}`;
          const hit = cache.get(key);
          if (hit && now - hit.at < CACHE_MS && http.query.refresh !== "1") return hit.value;
          const value = listContacts(bot, ctx.clock);
          cache.set(key, { at: now, value });
          // A failed listing must not be served from cache.
          value.catch(() => cache.delete(key));
          return value;
        }),
      ),
    } satisfies ContactsResponse;
  });
}

export async function listContacts(bot: ListBot, clock: Clock, timeoutMs = TIMEOUT_MS): Promise<BotContacts> {
  const deadline = clock.now() + timeoutMs;
  const [groups, friends] = await Promise.all([
    collect(
      (next) => bot.getGuildList(next),
      (guild) => (guild?.id ? { channelId: String(guild.id), name: text(guild.name) || String(guild.id), direct: false } : undefined),
      deadline,
      clock,
    ),
    collect(
      (next) => bot.getFriendList(next),
      (friend) => {
        const user = friend?.user ?? friend;
        return user?.id
          ? {
              channelId: directChannelId(bot.platform, String(user.id)),
              name: text(friend.nick) || text(user.nick) || text(user.name) || String(user.id),
              direct: true,
            }
          : undefined;
      },
      deadline,
      clock,
    ),
  ]);
  return {
    platform: bot.platform,
    selfId: bot.selfId,
    name: text(bot.user?.nick) || text(bot.user?.name) || bot.selfId,
    contacts: [...groups.items, ...friends.items],
    partial: groups.partial || friends.partial,
  };
}

async function collect<T>(
  page: (next?: string) => Promise<{ data: T[]; next?: string }>,
  map: (item: T) => ContactEntry | undefined,
  deadline: number,
  clock: Clock,
): Promise<{ items: ContactEntry[]; partial: boolean }> {
  const items: ContactEntry[] = [];
  const seen = new Set<string>();
  let next: string | undefined;
  try {
    do {
      const remaining = deadline - clock.now();
      if (remaining <= 0) return { items, partial: true };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        page(next),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), remaining))),
      ]).finally(() => clearTimeout(timer));
      for (const item of Array.isArray(result?.data) ? result.data : []) {
        const entry = map(item);
        if (!entry || seen.has(entry.channelId)) continue;
        if (items.length >= MAX_PER_KIND) return { items, partial: true };
        seen.add(entry.channelId);
        items.push(entry);
      }
      next = typeof result?.next === "string" && result.next ? result.next : undefined;
    } while (next);
  } catch {
    return { items, partial: true };
  }
  return { items, partial: false };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 100) : "";
}
