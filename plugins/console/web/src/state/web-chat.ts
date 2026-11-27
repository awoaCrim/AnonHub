import { computed, reactive } from "vue";

import type { ChatAttachment, ChatConversationRequest, ChatMessage, ChatSendResponse, ChatSnapshot } from "../../../src/shared/chat";
import { ApiError, api } from "../lib/api";

/** A message this page sent that the server snapshot does not list yet. */
interface Pending {
  clientId: string;
  /** The conversation it was sent to. */
  conversation?: string;
  text: string;
  /** Uploaded files it carries (kept so a retry can send the same message). */
  uploads: string[];
  /** What it carries, with local previews of its images. */
  attachments?: ChatAttachment[];
  at: number;
  /** Still going to the server (or being retried), or given up on. */
  state: "sending" | "failed";
  /** Requests that ended without an answer; the message may still have landed. */
  unanswered: number;
  /** Why it failed, in plain words. */
  reason?: string;
  /** Known once the server accepted it; the snapshot then lists it under this ID. */
  messageId?: string;
}

/** An answer that never came, or a gateway's own error page: the server may or may not have the message. */
function unanswered(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 0 || (error.status >= 502 && error.status <= 504 && error.code.startsWith("http_"));
}

/** Plain words for the send errors the chat API answers with. */
export function chatError(error: unknown): string {
  if (!(error instanceof ApiError)) return "网络连接不上，消息还没发出去，请稍后重试。";
  if (error.status === 404) return "这台服务器还没有开启网页对话。";
  return (
    {
      upload_expired: "附件已过期或电脑连接已改变，请重新上传。",
      busy: "它还在处理前面的消息，等一下再发。",
      runtime_not_ready: "机器人还没准备好，请稍后再发。",
      conversation_not_found: "这个对话已经不在列表里了，换一个对话再发。",
      invalid_chat_request: "消息不能为空，也不能超过 4000 个字。",
      login_required: "登录已过期，请重新登录。",
    }[error.code] ?? "消息没有发出去，请稍后重试。"
  );
}

const newClientId = () =>
  globalThis.crypto?.randomUUID?.() ??
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (digit) => (Number(digit) ^ ((Math.random() * 16) >> (Number(digit) / 4))).toString(16));

/**
 * The web chat with this account's own bot: the latest server snapshot plus what this page has just
 * sent. A sent message shows at once and the caller clears its input at once. The message keeps its
 * client ID as its ID, so a send whose answer was lost is retried under the same ID (the server
 * deduplicates) and the snapshot lists it whether or not the answer arrived. Only a send the server
 * really refused (or that stayed unanswered through every retry) is marked failed, on the message.
 */
export function createWebChat(request: typeof api = api, options: { retryDelays?: number[] } = {}) {
  const retryDelays = options.retryDelays ?? [1500, 4000];
  const state = reactive({
    snapshot: undefined as ChatSnapshot | undefined,
    /** The first read failed and no live snapshot has arrived. */
    loadError: "",
    /** The server has no web chat (older version) or it is not running. */
    unavailable: false,
    pending: [] as Pending[],
    /** A message is on its way to the server. It never blocks typing or sending the next one. */
    sending: false,
    /** Creating, opening or changing a conversation. */
    changing: false,
    /** The stop button was pressed and the server has not answered yet. */
    stopping: false,
    error: "",
  });
  const openConversation = () => state.snapshot?.conversation.id;
  let generation = 0;
  let disposed = false;
  /** Messages reach the server one at a time, in the order they were typed. */
  let tail: Promise<unknown> = Promise.resolve();

  function accept(snapshot: ChatSnapshot | undefined) {
    if (!snapshot) return;
    const previous = state.snapshot?.conversation;
    // A delayed SSE/read from before “new chat” must not restore its old bubbles.
    if (previous?.channel === snapshot.conversation.channel && snapshot.conversation.session < previous.session) return;
    state.snapshot = snapshot;
    state.loadError = "";
    state.unavailable = false;
    const listed = new Set(snapshot.messages.map((message) => message.id));
    state.pending = state.pending.filter((item) => !listed.has(item.messageId ?? item.clientId));
  }

  /** One read for the first paint; the live topic keeps it current afterwards. */
  async function load() {
    const token = ++generation;
    try {
      const snapshot = await request<ChatSnapshot>("/yesimbot/api/v1/chat", undefined, { fresh: true });
      if (token === generation) accept(snapshot);
    } catch (error) {
      if (token !== generation || state.snapshot) return;
      if (error instanceof ApiError && (error.status === 404 || error.code === "runtime_not_ready")) state.unavailable = true;
      else state.loadError = "暂时读不到对话，稍后会自动重试。";
    }
  }

  /** One message to the server, retried under the same client ID while no answer arrives. */
  async function deliver(item: Pending): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await request<ChatSendResponse>("/yesimbot/api/v1/chat/send", {
          text: item.text,
          ...(item.uploads.length ? { uploads: item.uploads } : {}),
          clientId: item.clientId,
          ...(item.conversation !== undefined ? { conversation: item.conversation } : {}),
        });
        const current = state.pending.find((entry) => entry.clientId === item.clientId);
        if (current) {
          current.messageId = result.messageId;
          current.state = "sending";
          current.unanswered = 0;
          // The snapshot may already list it (the live update can beat the response).
          if (state.snapshot?.messages.some((message) => message.id === result.messageId)) accept(state.snapshot);
        }
        return true;
      } catch (error) {
        const current = state.pending.find((entry) => entry.clientId === item.clientId);
        // The snapshot listed it meanwhile: it landed, whatever the answer said.
        if (!current) return true;
        if (unanswered(error)) {
          current.unanswered++;
          if (attempt < retryDelays.length && !disposed) {
            await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
            if (disposed || !state.pending.includes(current)) return !disposed;
            continue;
          }
        }
        current.state = "failed";
        current.reason = chatError(error);
        if (error instanceof ApiError && error.status === 404) state.unavailable = true;
        return false;
      }
    }
  }

  function enqueue(item: Pending): Promise<boolean> {
    const run = tail.then(() => deliver(item));
    tail = run.catch(() => {});
    state.sending = true;
    void tail.then(() => {
      state.sending = state.pending.some((entry) => entry.state === "sending" && entry.messageId === undefined);
    });
    return run;
  }

  /**
   * Shows one message at once and sends it. The caller clears its input right away: nothing comes back to
   * it. Resolves to whether the server accepted the message; a failure stays on the message, with a retry.
   */
  function send(text: string, uploads: string[] = [], attachments: ChatAttachment[] = []): Promise<boolean> {
    const value = text.trim();
    if (!value && !uploads.length) return Promise.resolve(false);
    const conversation = openConversation();
    const item: Pending = {
      clientId: newClientId(),
      text: value,
      uploads: [...uploads],
      at: Date.now(),
      state: "sending",
      unanswered: 0,
      ...(attachments.length ? { attachments } : {}),
      ...(conversation !== undefined ? { conversation } : {}),
    };
    state.pending.push(item);
    state.error = "";
    return enqueue(state.pending[state.pending.length - 1]!);
  }

  /** Sends a failed message again under its own ID, so a copy that did land is not duplicated. */
  function retry(id: string): Promise<boolean> {
    const item = state.pending.find((entry) => entry.state === "failed" && (entry.messageId ?? entry.clientId) === id);
    if (!item) return Promise.resolve(false);
    item.state = "sending";
    item.unanswered = 0;
    delete item.reason;
    return enqueue(item);
  }

  /**
   * New, open, rename, choose a role card or model for, or remove a conversation. The open conversation
   * is the server's; the fresh snapshot is read at once so the switch does not wait for the live update.
   * Resolves to an error message, or "" when done.
   */
  async function change(body: ChatConversationRequest): Promise<string> {
    if (state.changing) return "";
    state.changing = true;
    try {
      await request<{ id: string }>("/yesimbot/api/v1/chat/conversations", body);
      if (body.action !== "update") accept(await request<ChatSnapshot>("/yesimbot/api/v1/chat", undefined, { fresh: true }));
      return "";
    } catch (error) {
      if (!(error instanceof ApiError)) return "网络连接不上，请稍后再试。";
      return (
        {
          unknown_model: "这个模型现在用不了，换一个试试。",
          conversation_not_found: "这个对话已经不在了。",
          too_many_conversations: "对话太多了，先移除几个不用的。",
          login_required: "登录已过期，请重新登录。",
        }[error.code] ?? "没有改成，请稍后再试。"
      );
    } finally {
      state.changing = false;
    }
  }

  /** The stop button: ends the bot's current reply in the open conversation. Resolves to an error message, or "". */
  async function stop(): Promise<string> {
    const conversation = openConversation();
    if (state.stopping || conversation === undefined) return "";
    state.stopping = true;
    try {
      await request<{ stopped: boolean }>("/yesimbot/api/v1/chat/stop", { conversation });
      return "";
    } catch (error) {
      if (!(error instanceof ApiError)) return "网络连接不上，没能停下，请稍后再试。";
      return error.code === "login_required" ? "登录已过期，请重新登录。" : "没能停下，请稍后再试。";
    } finally {
      state.stopping = false;
    }
  }

  const messages = computed<ChatMessage[]>(() => [
    // The server has accepted what its snapshot lists, so it is never shown as still sending.
    ...(state.snapshot?.messages ?? []).map((message) =>
      message.role === "user" && message.status === "sending" ? { ...message, status: "sent" as const } : message,
    ),
    ...state.pending
      .filter((item) => item.conversation === openConversation())
      .map((item) => ({
        id: item.messageId ?? item.clientId,
        role: "user" as const,
        text: item.text,
        at: item.at,
        // Quietly on its way: no spinner until the first answer was lost and it is being tried again.
        status: item.state === "failed" ? ("failed" as const) : item.unanswered ? ("sending" as const) : ("sent" as const),
        ...(item.attachments ? { attachments: item.attachments } : {}),
      })),
  ]);
  /** A message of this page that failed and can be sent again, with why. */
  const failure = (id: string) => state.pending.find((entry) => entry.state === "failed" && (entry.messageId ?? entry.clientId) === id)?.reason;
  /** Older messages, thoughts and tools: this conversation's full record on the 对话 page. */
  const historyLink = computed(() => {
    const conversation = state.snapshot?.conversation;
    return conversation?.channel ? `/conversations?c=${encodeURIComponent(conversation.channel)}` : undefined;
  });

  return {
    state,
    messages,
    historyLink,
    activity: computed(() => state.snapshot?.activity),
    typing: computed(() => !!state.snapshot?.typing),
    accept,
    load,
    send,
    retry,
    failure,
    change,
    stop,
    dispose: () => {
      disposed = true;
      generation++;
    },
  };
}
