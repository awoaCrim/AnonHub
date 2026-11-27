import { resolve } from "node:path";

import { WEB_CHAT, WEB_CONVERSATION_ID, webChatConversation } from "@yesimbot/contracts/platforms";
import type { ChannelContext } from "koishi-plugin-yesimbot/kernel";

import { readAdminLoginBody, type AdminAuth } from "../admin-auth.js";
import { listChannelSessions, readConversationDetail, type ChannelManifest, type ConversationAssetView } from "../conversation-history.js";
import type { Host } from "../host.js";
import { relayChatUsername } from "../relay-chat-identity.js";
import type { ChatAttachment, ChatConversation, ChatMessage, ChatSendRequest, ChatSnapshot } from "../shared/chat.js";
import { assetUrl, computerFileUrl, installChatAttachments, uploadPath } from "./chat-attachments.js";
import { webConversationContext, type ProjectedChat, type WebChatTransport } from "./chat-bot.js";
import { ChatConversations, type StoredConversation } from "./chat-conversations.js";
import { sentByUser, webReactionPlugin } from "./chat-reactions.js";
import { installChatUploads } from "./chat-uploads.js";
import { authorizeOwner, type HttpContext } from "./plugins.js";
import { ChangeSignal, type TopicRegistry } from "./topics.js";

export const CHAT_PATH = "/yesimbot/api/v1/chat";

/** Messages accepted over HTTP but not yet saved by Core. Saved messages no longer count. */
export const CHAT_PENDING_LIMIT = 4;

const RETRY_WINDOW = 10 * 60_000;

const MAX_RECEIPTS = 4096;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Core = Host["yesimbot"];

interface Receipt {
  message: ChatMessage;
  conversation: string;
  expires: number;
}

/** HTTP/topic lifetime survives a replaceable Core service. All identities are runtime-local. */
export function installChat(ctx: Host, auth: AdminAuth, topics: TopicRegistry) {
  const signal = new ChangeSignal();
  const receipts = new Map<string, Receipt>();
  /**
   * Running turns and the conversation each belongs to. `replied`: the bot has sent a message since its last stated
   * activity, so the chat stops showing it as busy until it states a new one (user, 2026-11-18: a sent reply kept
   * showing the earlier 「检索…」 for minutes while the turn wrapped up).
   */
  const turns = new Map<string, { conversation: string; activity?: string; replied?: boolean }>();
  const conversations = new ChatConversations(resolve(ctx.baseDir, "data/console-admin/web-chat.json"), ctx.clock);
  const loaded = conversations.load();
  const uploads = installChatUploads(
    ctx,
    auth,
    async () => {
      await loaded;
      return webConversationContext(conversations.current);
    },
    () => binding?.core,
  );
  installChatAttachments(ctx, auth, {
    core: () => binding?.core,
    context: async (conversation) => {
      await loaded;
      return isConversationId(conversation) && conversations.get(conversation) ? webConversationContext(conversation) : undefined;
    },
  });
  /** Core keeps each conversation's choices in memory only: hand them over whenever Core starts. */
  const apply = (core: Core, entry: StoredConversation) => core.overrides?.set(webConversationContext(entry.id), overrideOf(entry));
  /** Resolvers for messages waiting to be saved by Core, keyed by message ID. */
  const admissions = new Map<string, () => void>();
  let pending = 0;
  let tail = Promise.resolve();
  let binding: { bot: WebChatTransport; core: Host["yesimbot"] } | undefined;

  ctx.inject(["yesimbot"], (scope) => {
    const current = {
      bot: scope.openWebChat((conversation) => {
        for (const turn of turns.values()) {
          if (turn.conversation !== conversation) continue;
          turn.replied = true;
          delete turn.activity;
        }
        // The list order is cosmetic: a failed write never disturbs the chat.
        void conversations
          .touch(conversation, undefined)
          .catch(() => {})
          .finally(() => signal.emit());
      }),
      core: scope.yesimbot,
    };
    binding = current;
    void loaded.then(() => Promise.all(conversations.list().map((entry) => apply(current.core, entry)))).catch(() => {});
    scope.on("yesimbot/turn", ({ context, turnId, active, activity }) => {
      if (context.platform !== WEB_CHAT.platform || context.type !== "direct" || context.selfId !== WEB_CHAT.selfId) return;
      const conversation = webChatConversation(context.userId);
      if (conversation === undefined) return;
      // Keep the last public intent while the same turn waits for its next step.
      // End/failure removes the turn, so later replies cannot inherit this text.
      const stated = activity?.trim();
      const previous = turns.get(turnId);
      if (!active) turns.delete(turnId);
      else if (stated) turns.set(turnId, { conversation, activity: stated });
      else
        turns.set(turnId, {
          conversation,
          ...(previous?.activity ? { activity: previous.activity } : {}),
          ...(previous?.replied ? { replied: true } : {}),
        });
      signal.emit();
    });
    scope.on("yesimbot/message", (message) => {
      if (message.data.platform !== WEB_CHAT.platform || message.data.selfId !== WEB_CHAT.selfId) return;
      for (const receipt of receipts.values()) if (receipt.message.id === message.data.messageId) receipt.message.status = "sent";
      admissions.get(message.data.messageId)?.();
      signal.emit();
    });
    // The bot's emoji reactions in web conversations, kept with the conversation list.
    const disposeReactions = scope.yesimbot.agent.use({
      id: "yesimbot-web-chat",
      setup: (context) => {
        if (context.type !== "direct" || context.platform !== WEB_CHAT.platform || context.selfId !== WEB_CHAT.selfId) return null;
        const conversation = webChatConversation(context.userId);
        if (conversation === undefined) return null;
        return webReactionPlugin({
          isUserMessage: async (messageId) => {
            // Core refuses an ID it does not have: that is simply not the user's message here.
            const records = await current.core.conversation.read(context, { messageIds: [messageId] }).catch(() => []);
            return records.some((record) => record.messageId === messageId && sentByUser(record));
          },
          react: async (messageId, emoji) => {
            await loaded;
            await conversations.react(conversation, messageId, emoji);
            signal.emit();
          },
        });
      },
    });
    // Its computer and browser work, shown in the chat as it happens.
    const unwatch = current.core.devices.activity.subscribe((item) => {
      if (item.origin?.platform === WEB_CHAT.platform) signal.emit();
    });
    scope.on("dispose", () => {
      disposeReactions();
      unwatch();
      if (binding !== current) return;
      binding = undefined;
      turns.clear();
      signal.emit();
    });
  });

  const prune = () => {
    for (const [id, receipt] of receipts) if (receipt.expires <= ctx.clock.now() && receipt.message.status !== "sending") receipts.delete(id);
  };
  const busyTurn = (conversation: string) => [...turns.values()].find((turn) => turn.conversation === conversation && !turn.replied);
  const typingIn = (conversation: string) => busyTurn(conversation) !== undefined;
  /** One conversation (the open one by default), with the list of conversations and model choices. */
  const snapshot = async (_requested?: string): Promise<ChatSnapshot> => {
    const current = binding;
    if (!current) throw new Error("runtime_not_ready");
    await loaded;
    const id = conversations.current;
    const context = webConversationContext(id);
    const webManifest = sameChannel(context);
    const location = await current.core.conversation.locate(context);
    // Only this conversation's channel is read: an unrelated damaged manifest cannot take the chat down.
    const sessions = await listChannelSessions(ctx, location.channel, webManifest);
    const reactions = conversations.get(id)?.reactions ?? {};
    const messages = new Map<string, ChatMessage>();
    // Newest sessions/pages first, retaining only actual transport input/output. Model text and
    // proposed send_message calls are never evidence of a delivered bot message.
    for (const session of sessions.filter((item) => item.filename === location.session)) {
      let cursor: string | undefined;
      do {
        // Attachments are linked, never inlined: the snapshot is sent again on every change.
        const page = await readConversationDetail(ctx, { channel: location.channel, session: session.filename, cursor, inlineAssets: false }, webManifest);
        for (const entry of [...page.entries].reverse()) {
          if (!entry.messageId || (entry.kind !== "user" && entry.eventType !== "platform-message") || messages.has(entry.messageId)) continue;
          const reaction = entry.kind === "user" ? reactions[entry.messageId] : undefined;
          messages.set(entry.messageId, {
            id: entry.messageId,
            role: entry.kind === "user" ? "user" : "bot",
            at: entry.timestamp,
            status: "sent",
            ...chatContent(id, entry.text ?? "", entry.assets ?? [], ctx.projectChatContent(entry.text ?? "")),
            ...(entry.kind !== "user" && entry.choices?.length ? { choices: entry.choices } : {}),
            ...(reaction ? { reaction } : {}),
          });
          if (messages.size >= 50) break;
        }
        cursor = page.nextCursor;
      } while (cursor && messages.size < 50);
      if (messages.size >= 50) break;
    }
    if (binding !== current) throw new Error("runtime_not_ready");
    prune();
    const ordered = new Map([...messages].reverse());
    for (const receipt of receipts.values()) {
      // Persisted input is canonical on disk (it was admitted). Pending/failed admission stays visible.
      if (receipt.conversation === id && !ordered.has(receipt.message.id) && receipt.message.status !== "sent")
        ordered.set(receipt.message.id, { ...receipt.message });
    }
    const list: ChatConversation[] = conversations.list().map((entry) => ({
      id: entry.id,
      title: entry.title,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      ...(entry.roleCard !== undefined ? { roleCard: entry.roleCard } : {}),
      ...(entry.chatModel ? { chatModel: entry.chatModel } : {}),
      ...(typingIn(entry.id) ? { typing: true } : {}),
    }));
    return {
      conversation: { platform: "web", ...location, id },
      computerDeviceId: current.core.devices.workspaceDevice(context),
      messages: [...ordered.values()].sort((a, b) => a.at - b.at).slice(-50),
      typing: typingIn(id),
      activity: busyTurn(id)?.activity,
      conversations: list,
      models: current.core.model.listChatModels().map(({ fullId }) => ({ id: fullId, label: modelLabel(fullId) })),
      ...(current.core.config.chatModel ? { defaultModel: current.core.config.chatModel } : {}),
    };
  };
  ctx.on(
    "dispose",
    topics.register({
      name: "chat",
      authorize: (session) => session.role !== "member",
      get: () => snapshot(),
      subscribe: (listener) => signal.subscribe(listener),
    }),
  );

  ctx.server.get(CHAT_PATH, async (http) => {
    if (!authorizeOwner(http, auth)) return;
    const session = auth.sessionFromCookie(http.get("cookie"));
    try {
      const body = await snapshot(typeof http.query.conversation === "string" ? http.query.conversation : undefined);
      if (auth.sessionFromCookie(http.get("cookie")) !== session) return fail(http, 401, "login_required");
      http.body = body;
    } catch {
      fail(http, 503, "runtime_not_ready");
    }
  });

  ctx.server.post(`${CHAT_PATH}/send`, async (http) => {
    if (!authorizeOwner(http, auth, true)) return;
    const cookie = http.get("cookie");
    const session = auth.sessionFromCookie(cookie)!;
    let request: ChatSendRequest;
    try {
      const body = (await readAdminLoginBody(http, 32 * 1024)) as Partial<ChatSendRequest>;
      if (
        Object.keys(body).some((key) => key !== "text" && key !== "clientId" && key !== "conversation" && key !== "uploads") ||
        typeof body.text !== "string" ||
        typeof body.clientId !== "string" ||
        !UUID.test(body.clientId) ||
        (body.conversation !== undefined && !isConversationId(body.conversation))
      )
        throw new Error();
      const text = body.text.trim();
      if (
        body.uploads !== undefined &&
        (!Array.isArray(body.uploads) || body.uploads.length > 8 || body.uploads.some((id) => typeof id !== "string" || !UUID.test(id)))
      )
        throw new Error();
      if ((!text.length && !body.uploads?.length) || [...text].length > 4000) throw new Error();
      request = {
        text,
        uploads: body.uploads,
        clientId: body.clientId.toLowerCase(),
        ...(body.conversation !== undefined ? { conversation: body.conversation } : {}),
      };
    } catch {
      return fail(http, 400, "invalid_chat_request");
    }
    if (auth.sessionFromCookie(cookie) !== session) return fail(http, 401, "login_required");
    prune();
    const previous = receipts.get(request.clientId);
    if (previous) {
      http.status = 202;
      http.body = { messageId: previous.message.id };
      return;
    }
    const current = binding;
    if (!current) return fail(http, 503, "runtime_not_ready");
    await loaded;
    const conversation = conversations.current;
    if (request.conversation !== undefined && request.conversation !== conversation) return fail(http, 409, "conversation_target_changed");
    const entry = conversations.get(conversation);
    if (!entry) return fail(http, 404, "conversation_not_found");
    try {
      if (!current.bot.isOnline()) throw new Error();
      const own = entry.chatModel && current.core.model.listChatModels().some((model) => model.fullId === entry.chatModel) ? entry.chatModel : undefined;
      current.core.model.resolveChatModel(own ?? current.core.config.chatModel ?? "", webConversationContext(conversation));
    } catch {
      return fail(http, 503, "runtime_not_ready");
    }
    if (pending >= CHAT_PENDING_LIMIT || receipts.size >= MAX_RECEIPTS) return fail(http, 429, "busy");
    let files: Awaited<ReturnType<typeof uploads.resolve>> = [];
    try {
      if (request.uploads?.length) files = await uploads.resolve(request.uploads, webConversationContext(conversation));
    } catch {
      return fail(http, 409, "upload_expired");
    }
    const message: ChatMessage = {
      // The client's own ID: its page lists the message under it before and whether or not our answer arrives.
      id: request.clientId,
      role: "user",
      text: request.text,
      at: ctx.clock.now(),
      status: "sending",
      attachments: files.map((file) => ({
        name: file.name,
        kind: file.kind,
        ...(file.asset
          ? { url: assetUrl(conversation, file.asset, file.name) }
          : uploadPath(file.uri)
            ? { url: computerFileUrl(conversation, uploadPath(file.uri)!, file.name) }
            : {}),
      })),
    };
    receipts.set(request.clientId, { message, conversation, expires: ctx.clock.now() + RETRY_WINDOW });
    void conversations.touch(conversation, request.text).catch(() => {});
    pending++;
    const username = relayChatUsername(http, session.username);
    // Ingress is serial only until Core saves each message, preserving order without waiting for
    // the whole reply. Core owns batching and interruption when later user messages arrive.
    tail = tail.then(async () => {
      const saved = new Promise<void>((resolve) => admissions.set(message.id, resolve));
      const received = (async () => {
        try {
          if (binding !== current) throw new Error("runtime_not_ready");
          await current.bot.receive(username, message.text, message.id, message.at, conversation, files, () => auth.sessionFromCookie(cookie) === session);
          message.status = "sent";
        } catch {
          // A failure after Core persisted the input (observed as `yesimbot/message`) is not a failed
          // admission: the message is in history and a fresh retry would duplicate it.
          if (message.status !== "sent") message.status = "failed";
        } finally {
          signal.emit();
        }
      })();
      try {
        await Promise.race([saved, received]);
      } finally {
        admissions.delete(message.id);
        pending--;
        signal.emit();
      }
    });
    signal.emit();
    http.status = 202;
    http.body = { messageId: message.id };
  });

  // New, open, rename, choose the role card or model of, or remove a conversation.
  ctx.server.post(`${CHAT_PATH}/conversations`, async (http) => {
    if (!authorizeOwner(http, auth, true)) return;
    const cookie = http.get("cookie");
    const session = auth.sessionFromCookie(cookie)!;
    let body: Record<string, unknown>;
    try {
      body = (await readAdminLoginBody(http, 8 * 1024)) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch {
      return fail(http, 400, "invalid_chat_request");
    }
    if (auth.sessionFromCookie(cookie) !== session) return fail(http, 401, "login_required");
    const current = binding;
    if (!current) return fail(http, 503, "runtime_not_ready");
    await loaded;
    const id = body.id;
    try {
      if (body.action === "update" && isConversationId(id) && id === conversations.current) {
        const { title, roleCard, chatModel } = body;
        if (Object.keys(body).some((key) => !["action", "id", "title", "roleCard", "chatModel"].includes(key))) throw new Error("invalid_chat_request");
        if (title !== undefined && (typeof title !== "string" || [...title].length > 40)) throw new Error("invalid_chat_request");
        if (roleCard !== undefined && roleCard !== null && (typeof roleCard !== "string" || (roleCard !== "" && !roleCardPath(roleCard))))
          throw new Error("invalid_chat_request");
        if (chatModel !== undefined && chatModel !== null) {
          if (typeof chatModel !== "string" || !current.core.model.listChatModels().some((model) => model.fullId === chatModel))
            throw new Error("unknown_model");
        }
        const entry = await conversations.update(id, {
          ...(title !== undefined ? { title: title as string } : {}),
          ...(roleCard !== undefined ? { roleCard: roleCard as string | null } : {}),
          ...(chatModel !== undefined ? { chatModel: chatModel as string | null } : {}),
        });
        await apply(current.core, entry);
        http.body = { id };
      } else throw new Error("invalid_chat_request");
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "conversation_not_found") return fail(http, 404, code);
      if (code === "too_many_conversations") return fail(http, 409, code);
      return fail(http, 400, code === "unknown_model" ? code : "invalid_chat_request");
    } finally {
      signal.emit();
    }
  });
  // The stop button: end the bot's current reply in the open conversation. Background tasks keep running.
  ctx.server.post(`${CHAT_PATH}/stop`, async (http) => {
    if (!authorizeOwner(http, auth, true)) return;
    const cookie = http.get("cookie");
    const session = auth.sessionFromCookie(cookie)!;
    let conversation: string;
    try {
      const body = (await readAdminLoginBody(http, 1024)) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Object.keys(body).some((key) => key !== "conversation") || !isConversationId(body.conversation))
        throw new Error();
      conversation = body.conversation;
    } catch {
      return fail(http, 400, "invalid_chat_request");
    }
    if (auth.sessionFromCookie(cookie) !== session) return fail(http, 401, "login_required");
    const current = binding;
    if (!current) return fail(http, 503, "runtime_not_ready");
    await loaded;
    if (!conversations.get(conversation)) return fail(http, 404, "conversation_not_found");
    try {
      http.body = { stopped: await current.core.conversation.interrupt(webConversationContext(conversation)) };
    } catch {
      return fail(http, 503, "runtime_not_ready");
    } finally {
      signal.emit();
    }
  });
  return { snapshot };
}

/** What Core should use for one conversation: only the choices it made. */
const overrideOf = (entry: StoredConversation) => ({
  ...(entry.chatModel ? { chatModel: entry.chatModel } : {}),
  ...(entry.roleCard !== undefined ? { roleCard: entry.roleCard } : {}),
});

/** `connection:model` reads `model · connection`; generated connection IDs are left out. */
function modelLabel(fullId: string): string {
  const split = fullId.indexOf(":");
  if (split < 0) return fullId;
  const connection = fullId.slice(0, split),
    model = fullId.slice(split + 1);
  return /^(connection-)?[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(connection) ? model : `${model} · ${connection}`;
}

/** A role card ID is the card's path inside the instance, as the roleplay library lists it. */
const roleCardPath = (value: string) =>
  value.length <= 2048 && !value.includes("\0") && value.toLowerCase().endsWith(".png") && !value.startsWith("/") && !value.split(/[\\/]/).includes("..");

/**
 * What one saved message shows: its words, and its images and files with console URLs. The model-facing
 * `[图片：asset://…]` marks of attachments it shows are left out of the words.
 */
function chatContent(
  conversation: string,
  text: string,
  assets: readonly ConversationAssetView[],
  content: ProjectedChat,
): Pick<ChatMessage, "text" | "attachments"> {
  const shown = new Set(assets.flatMap((asset) => (asset.id ? [asset.id] : [])));
  const nameOf = (asset: ConversationAssetView) => asset.title || (asset.kind === "image" ? "图片" : "文件");
  const linked: ChatAttachment[] = assets.map((asset) => ({
    kind: asset.kind,
    name: nameOf(asset),
    ...(asset.id ? { url: assetUrl(conversation, asset.id, nameOf(asset)), size: asset.size } : {}),
  }));
  // An image sent with a copy on the computer is shown once, from the conversation.
  const images = new Set(assets.filter((asset) => asset.kind === "image" && asset.id).map(nameOf));
  const copies: ChatAttachment[] = content.attachments
    .filter((item) => !(item.uri && item.kind === "image" && images.has(item.name)))
    .map((item) => {
      const path = uploadPath(item.uri);
      return { kind: item.kind, name: item.name, ...(path ? { url: computerFileUrl(conversation, path, item.name) } : {}) };
    });
  const words = content.text.replace(/\[(?:图片|文件)：[^\]\n]*?asset:\/\/([a-f0-9]{32})\]/g, (mark, id: string) => (shown.has(id) ? "" : mark));
  return { text: words === content.text ? words : words.trim(), attachments: [...linked, ...copies] };
}

const isConversationId = (value: unknown): value is string => typeof value === "string" && (value === "" || WEB_CONVERSATION_ID.test(value));

/** The manifest of exactly this conversation's channel. */
function sameChannel(context: ChannelContext) {
  return (manifest: ChannelManifest) =>
    manifest.type === "direct" &&
    manifest.platform === WEB_CHAT.platform &&
    manifest.selfId === WEB_CHAT.selfId &&
    context.type === "direct" &&
    manifest.userId === context.userId &&
    manifest.channelId === context.channelId;
}

function fail(http: HttpContext, status: number, message: string) {
  http.status = status;
  http.body = { message };
}
