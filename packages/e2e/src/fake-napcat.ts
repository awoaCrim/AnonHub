import WebSocket from "ws";

const UNKNOWN = Symbol("unknown action");

type Handler = (params: Record<string, unknown>) => unknown;

/** One OneBot API call the host made, with the fake's answer. */
export interface OnebotCall {
  readonly action: string;
  readonly params: Record<string, unknown>;
}

export interface OnebotSegment {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/** A message the host asked NapCat to send. */
export interface OnebotSend {
  readonly target: { readonly kind: "private"; readonly userId: string } | { readonly kind: "group"; readonly groupId: string };
  readonly segments: readonly OnebotSegment[];
  readonly text: string;
  readonly messageId: number;
}

/**
 * Stands in for NapCat: dials the host's reverse OneBot v11 WebSocket as `selfId`, posts message events and answers
 * API calls. Sends get real message IDs, the delivery proof the host waits for.
 */
export class FakeNapcat {
  readonly calls: OnebotCall[] = [];
  readonly sends: OnebotSend[] = [];
  /** Overrides for single actions; throw to answer with a failure. */
  readonly handlers: Record<string, Handler> = {};
  private nextMessageId = 1000;
  private readonly stored = new Map<number, Record<string, unknown>>();
  private constructor(
    private readonly socket: WebSocket,
    readonly selfId: string,
  ) {}

  static async connect(url: string, selfId: string): Promise<FakeNapcat> {
    const socket = new WebSocket(url, { headers: { "X-Self-ID": selfId, "X-Client-Role": "Universal", "User-Agent": "NapCat.OneBot/fake" } });
    const napcat = new FakeNapcat(socket, selfId);
    socket.on("message", (data) => napcat.onMessage(String(data)));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) => reject(new Error(`onebot handshake refused: ${response.statusCode}`)));
    });
    napcat.post({ post_type: "meta_event", meta_event_type: "lifecycle", sub_type: "connect" });
    return napcat;
  }

  /** A private message from `userId`, with pictures at `images` (URLs as NapCat gives them); returns its message ID. */
  privateMessage(userId: string, text: string, options: { nickname?: string; images?: readonly string[] } = {}): number {
    const id = this.nextMessageId++;
    const message = [{ type: "text", data: { text } }, ...(options.images ?? []).map((url) => ({ type: "image", data: { file: "photo.png", url } }))];
    const event = {
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      message_id: id,
      user_id: Number(userId),
      message,
      raw_message: text,
      message_format: "array",
      font: 0,
      sender: { user_id: Number(userId), nickname: options.nickname ?? `用户${userId}` },
    };
    this.stored.set(id, event);
    this.post(event);
    return id;
  }

  /** A group message; `atSelf` puts an @ of the bot in front. Returns its message ID. */
  groupMessage(groupId: string, userId: string, text: string, options: { atSelf?: boolean; nickname?: string } = {}): number {
    const id = this.nextMessageId++;
    const message = [
      ...(options.atSelf
        ? [
            { type: "at", data: { qq: this.selfId } },
            { type: "text", data: { text: " " } },
          ]
        : []),
      { type: "text", data: { text } },
    ];
    const event = {
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: id,
      group_id: Number(groupId),
      user_id: Number(userId),
      message,
      raw_message: (options.atSelf ? `[CQ:at,qq=${this.selfId}] ` : "") + text,
      message_format: "array",
      font: 0,
      sender: { user_id: Number(userId), nickname: options.nickname ?? `用户${userId}`, card: "", role: "member" },
    };
    this.stored.set(id, event);
    this.post(event);
    return id;
  }

  close(): void {
    this.socket.close();
  }

  private post(event: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: Number(this.selfId), ...event }));
  }

  private onMessage(raw: string): void {
    const request = JSON.parse(raw) as { action: string; params?: Record<string, unknown>; echo: unknown };
    const params = request.params ?? {};
    this.calls.push({ action: request.action, params });
    let reply: { status: "ok" | "failed"; retcode: number; data: unknown; message?: string };
    try {
      const data = (this.handlers[request.action] ?? ((value: Record<string, unknown>) => this.answer(request.action, value)))(params);
      reply = data === UNKNOWN ? { status: "failed", retcode: 1404, data: null, message: "不支持的 API" } : { status: "ok", retcode: 0, data };
    } catch (error) {
      reply = { status: "failed", retcode: 100, data: null, message: String((error as Error).message ?? error) };
    }
    this.socket.send(JSON.stringify({ ...reply, echo: request.echo }));
  }

  private answer(action: string, params: Record<string, unknown>): unknown {
    switch (action) {
      case "get_login_info":
        return { user_id: Number(this.selfId), nickname: "测试机器人" };
      case "get_status":
        return { online: true, good: true };
      case "get_version_info":
        return { app_name: "NapCat.Onebot", app_version: "4.0.0", protocol_version: "v11" };
      case "get_friend_list":
      case "get_group_list":
        return [];
      case "get_stranger_info":
        return { user_id: Number(params.user_id), nickname: `用户${String(params.user_id)}` };
      case "get_group_info":
        return { group_id: Number(params.group_id), group_name: `测试群${String(params.group_id)}`, member_count: 3, max_member_count: 200 };
      case "get_group_member_info":
        return { group_id: Number(params.group_id), user_id: Number(params.user_id), nickname: `用户${String(params.user_id)}`, card: "", role: "member" };
      case "get_msg": {
        const stored = this.stored.get(Number(params.message_id));
        if (!stored) throw new Error("消息不存在");
        return stored;
      }
      case "send_msg":
      case "send_private_msg":
      case "send_group_msg":
        return this.recordSend(action, params);
      default:
        return UNKNOWN;
    }
  }

  private recordSend(action: string, params: Record<string, unknown>): { message_id: number } {
    const segments = toSegments(params.message);
    const group =
      action === "send_group_msg" || (action === "send_msg" && params.message_type === "group") || (action === "send_msg" && params.group_id !== undefined);
    const messageId = this.nextMessageId++;
    this.sends.push({
      target: group ? { kind: "group", groupId: String(params.group_id) } : { kind: "private", userId: String(params.user_id) },
      segments,
      text: segments
        .filter((segment) => segment.type === "text")
        .map((segment) => String(segment.data.text))
        .join(""),
      messageId,
    });
    this.stored.set(messageId, { message_id: messageId, message: segments, raw_message: "", sender: { user_id: Number(this.selfId), nickname: "测试机器人" } });
    return { message_id: messageId };
  }
}

function toSegments(message: unknown): OnebotSegment[] {
  if (Array.isArray(message)) return message as OnebotSegment[];
  if (typeof message === "string") return [{ type: "text", data: { text: message } }];
  return [];
}
