import { isRetiredPlatform } from "@yesimbot/contracts/platforms";

import type { AdminAuth } from "../admin-auth.js";
import { readAdminLoginBody } from "../admin-auth.js";
import { buildConversationIndex, readConversationDetail, type ChannelManifest } from "../conversation-history.js";
import type { Host, HttpContext } from "../host.js";
import type { Topic, TopicRegistry } from "./topics.js";

/** Conversations that can run. The records of a retired platform (Xiaoheihe) are not among them. */
export const chatHistory = (manifest: ChannelManifest) => !isRetiredPlatform(manifest.platform);

/**
 * A topic that polls only while someone is subscribed, replacing the old
 * per-client `yesimbot/subscribe-view` demand switch.
 */
export function pollingTopic<T>(ctx: Host, name: string, intervalMs: number, get: () => Promise<T>): Topic<T> & { notify(): void } {
  const listeners = new Set<() => void>();
  let timer: (() => void) | undefined;
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    name,
    notify,
    // Members never reach parent-local data; on a child the browser holds the child's admin session.
    authorize: (session) => session.role !== "member",
    get,
    subscribe(listener) {
      listeners.add(listener);
      timer ??= ctx.setInterval(notify, intervalMs);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          timer?.();
          timer = undefined;
        }
      };
    },
  };
}

export function installHistory(ctx: Host, auth: AdminAuth, topics: TopicRegistry) {
  const conversations = pollingTopic(ctx, "conversations", 10_000, () => buildConversationIndex(ctx, storedHistory, false));
  const unregister = [topics.register(conversations)];
  ctx.on("dispose", () => unregister.forEach((dispose) => dispose()));

  const detail = (path: string, belongs: () => Promise<(manifest: ChannelManifest) => boolean>) =>
    ctx.server.post(path, async (http: HttpContext) => {
      http.set("Cache-Control", "private, no-store");
      const session = auth.sessionFromCookie(http.get("cookie"));
      if (!session || session.role === "member") {
        http.status = session ? 403 : 401;
        http.body = { message: session ? "owner_required" : "login_required" };
        return;
      }
      if (!auth.sameOrigin(http)) {
        http.status = 403;
        http.body = { message: "same_origin_required" };
        return;
      }
      try {
        const input = (await readAdminLoginBody(http)) as never;
        http.body = await readConversationDetail(ctx, input, await belongs());
      } catch {
        http.status = 400;
        http.body = { message: "invalid_conversation_request" };
      }
    });
  detail("/yesimbot/api/v1/conversations/detail", async () => storedHistory);

  ctx.server.post("/yesimbot/api/v1/conversations/archive", async (http: HttpContext) => {
    http.set("Cache-Control", "private, no-store");
    const cookie = http.get("cookie");
    const session = auth.sessionFromCookie(cookie);
    // The parent relay selects the member's child from the authenticated session. A member
    // must never reach this handler on the parent; the child sees its own private owner session.
    if (!session || session.role === "member") {
      http.status = session ? 403 : 401;
      http.body = { message: session ? "owner_required" : "login_required" };
      return;
    }
    if (!auth.sameOrigin(http)) {
      http.status = 403;
      http.body = { message: "same_origin_required" };
      return;
    }
    let request: { channel: string; session: string };
    try {
      const body = (await readAdminLoginBody(http)) as Record<string, unknown>;
      if (
        Object.keys(body).some((key) => key !== "channel" && key !== "session") ||
        typeof body.channel !== "string" ||
        !body.channel ||
        body.channel.length > 1024 ||
        /[/\\\\]/.test(body.channel) ||
        typeof body.session !== "string" ||
        !/^[0-9A-Za-zTZ_-]+\.jsonl$/.test(body.session)
      )
        throw new Error("invalid_request");
      request = { channel: body.channel, session: body.session };
    } catch {
      http.status = 400;
      http.body = { message: "invalid_conversation_request" };
      return;
    }
    if (auth.sessionFromCookie(cookie) !== session) {
      http.status = 401;
      http.body = { message: "login_required" };
      return;
    }
    try {
      await ctx.yesimbot.conversation.archive(request);
      conversations.notify();
      http.body = { archived: true };
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      const known = ["conversation_not_found", "conversation_changed", "conversation_empty"].includes(code);
      http.status = known ? (code === "conversation_not_found" ? 404 : 409) : 500;
      http.body = { message: known ? code : "conversation_archive_failed" };
    }
  });
}

/**
 * What 会话管理 lists and opens: every stored conversation, including the read-only records Xiaoheihe wrote
 * before it became an extension. Nothing here writes, and the archive route refuses them in Core.
 */
const storedHistory = () => true;
