import { AppError, defineErrors, errorFields, logger } from "@yesimbot/foundation";
import type { ConnectorSocket } from "koishi-plugin-yesimbot/kernel";

export const ONEBOT_PROTOCOL_ERRORS = defineErrors({
  onebot_action_failed: { model: "QQ 没有完成这个请求。", user: "QQ 没有完成这个请求。", status: 502 },
  onebot_action_timeout: { model: "QQ 没有及时回应。", user: "QQ 没有及时回应。", status: 504, retryable: true },
  onebot_disconnected: { model: "QQ 现在没有连上。", user: "QQ 现在没有连上。", status: 503, retryable: true },
});

const log = logger("onebot.protocol");

/** An action's answer as OneBot 11 gives it. */
export interface OneBotResponse<T = unknown> {
  readonly status: "ok" | "async" | "failed";
  readonly retcode: number;
  readonly data: T;
  readonly message?: string;
  readonly wording?: string;
}

/** An event NapCat posts: `post_type` and the fields of its kind. */
export interface OneBotEvent {
  readonly post_type: string;
  readonly [field: string]: unknown;
}

export interface OneBotSocketOptions {
  /** How long an action may take; NapCat answers most in well under a second, uploads take longer. */
  readonly timeoutMs: number;
  onEvent(event: OneBotEvent): void;
  onClose(): void;
}

/**
 * One OneBot 11 connection, the one NapCat dialed in: actions go out with an `echo` and come back by it; everything
 * else NapCat sends is an event. A closed connection fails what was still waiting.
 */
export class OneBotSocket {
  private readonly pending = new Map<string, { resolve(response: OneBotResponse): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  private nextEcho = 0;
  private closed = false;

  public constructor(
    private readonly socket: ConnectorSocket,
    private readonly options: OneBotSocketOptions,
  ) {
    socket.on("message", (data) => this.receive(data));
    socket.on("close", () => this.shut());
    socket.on("error", (error) => log.warn("socket.failed", { ...errorFields(error) }));
  }

  public get isOpen(): boolean {
    return !this.closed;
  }

  /** The whole answer, failed or not. */
  public request<T = unknown>(action: string, params: object = {}, timeoutMs = this.options.timeoutMs): Promise<OneBotResponse<T>> {
    if (this.closed) return Promise.reject(new AppError(ONEBOT_PROTOCOL_ERRORS.onebot_disconnected, { effect: "none", detail: action }));
    const echo = String(++this.nextEcho);
    return new Promise<OneBotResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        // The action may still happen on QQ's side: nothing can tell.
        reject(new AppError(ONEBOT_PROTOCOL_ERRORS.onebot_action_timeout, { effect: "unknown", detail: action }));
      }, timeoutMs);
      this.pending.set(echo, { resolve: resolve as (response: OneBotResponse) => void, reject, timer });
      try {
        this.socket.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(new AppError(ONEBOT_PROTOCOL_ERRORS.onebot_disconnected, { effect: "none", detail: action, cause: error }));
      }
    });
  }

  /**
   * The answer's `data`. Anything but retcode 0 throws `onebot_action_failed`, its retcode and message in `detail`: what
   * adapter-onebot's `internal` did, an `async` answer included.
   */
  public async call<T = unknown>(action: string, params: object = {}, timeoutMs?: number): Promise<T> {
    const response = await this.request<T>(action, params, timeoutMs);
    if (response.retcode !== 0)
      throw new AppError(ONEBOT_PROTOCOL_ERRORS.onebot_action_failed, {
        effect: "unknown",
        detail: `${action}: ${response.retcode} ${response.wording ?? response.message ?? ""}`.trim(),
      });
    return response.data;
  }

  public close(code = 1000, reason = ""): void {
    try {
      this.socket.close(code, reason);
    } finally {
      this.shut();
    }
  }

  private receive(data: Buffer | ArrayBuffer | Buffer[]): void {
    let payload: unknown;
    try {
      payload = JSON.parse(
        Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data).toString("utf8"),
      );
    } catch {
      log.warn("socket.unreadable");
      return;
    }
    if (!payload || typeof payload !== "object") return;
    const message = payload as Record<string, unknown>;
    if (message.echo !== undefined && message.post_type === undefined) {
      const waiting = this.pending.get(String(message.echo));
      if (!waiting) return;
      this.pending.delete(String(message.echo));
      clearTimeout(waiting.timer);
      waiting.resolve(message as unknown as OneBotResponse);
      return;
    }
    if (typeof message.post_type !== "string") return;
    try {
      this.options.onEvent(message as OneBotEvent);
    } catch (error) {
      log.error("event.failed", { postType: message.post_type, ...errorFields(error) });
    }
  }

  private shut(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [echo, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new AppError(ONEBOT_PROTOCOL_ERRORS.onebot_disconnected, { effect: "unknown", detail: `echo ${echo}` }));
    }
    this.pending.clear();
    this.options.onClose();
  }
}
