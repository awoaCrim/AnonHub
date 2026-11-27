import { join, resolve } from "node:path";

import { AppError, logger, systemClock, type Clock, type Logger } from "@yesimbot/foundation";
import { toBuffer } from "qrcode";

import { Account } from "./account.js";
import { createXiaoheiheApi, identity } from "./client.js";
import type { Config } from "./config.js";
import { errorCodeOf } from "./errors.js";
import { HeyboxHttp, type StoredCookie } from "./heybox/http.js";
import { loadSession, normalizeCookies, saveSession } from "./heybox/session.js";
import { record } from "./protocol.js";
import { AccountStore } from "./store.js";

// A reload starts the replacement while the old plugin is still draining. Serialize
// lifecycle work for the same on-disk account; never remove a live owner's exclusive lock.
const accountLifecycles = new Map<string, Promise<unknown>>();

const CONNECT_ERRORS = [
  "account_store_owned",
  "account_state_mismatch",
  "invalid_account_state",
  "authentication_required",
  "account_identity_mismatch",
  "session_invalid",
  "session_unreadable",
  "session_file_symlink",
  "xiaoheihe_upstream_failed",
];

export type LoginState = "idle" | "pending" | "finished";

/** What the service needs from its host: the data directory and a clock. */
export interface XiaoheiheServiceDeps {
  /** The state base directory; the account's session and state live under `data/yesimbot/xiaoheihe/<selfId>`. */
  readonly baseDir: string;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

/** What the console shows on its 服务连接 page; never carries cookies or post content. */
export interface XiaoheiheStatus {
  selfId: string;
  /** `connected`: session accepted; `login_required`: no usable session; `connecting` and `error` are transient or broken states. */
  state: "connecting" | "connected" | "login_required" | "error";
  paused: string | null;
  quarantinedPosts: number;
  newPostQuarantined: boolean;
  postsRemaining: number;
  interactionsRemaining: number;
  login: { state: LoginState; image?: string; message?: string };
}

/**
 * The bound Xiaoheihe account as a plain service: it opens the stored session and state on
 * start, serves the agent tools and the console's login card, and does nothing on its own.
 */
export class XiaoheiheService {
  account?: Account;
  webLogin: { state: LoginState; image?: string; message?: string } = { state: "idle" };
  private state: XiaoheiheStatus["state"] = "connecting";
  private disposed = false;

  private readonly log: Logger;
  private readonly clock: Clock;

  constructor(
    private readonly deps: XiaoheiheServiceDeps,
    readonly config: Config,
  ) {
    this.log = deps.logger ?? logger("yesimbot.xiaoheihe");
    this.clock = deps.clock ?? systemClock();
  }

  private get directory(): string {
    return join(this.deps.baseDir, "data", "yesimbot", "xiaoheihe", this.config.selfId);
  }

  private get sessionFile(): string {
    return resolve(this.directory, "session.json");
  }

  status(): XiaoheiheStatus {
    const summary = this.account?.status();
    return {
      selfId: this.config.selfId,
      state: this.account?.loginRequired ? "login_required" : this.account ? "connected" : this.state,
      paused: summary?.paused ?? null,
      quarantinedPosts: summary?.quarantinedPosts ?? 0,
      newPostQuarantined: summary?.newPostQuarantined ?? false,
      postsRemaining: summary?.postsRemaining ?? 0,
      interactionsRemaining: summary?.interactionsRemaining ?? 0,
      login: { ...this.webLogin },
    };
  }

  /** The connected account, or the login-needed error the tools show to the model. */
  requireAccount(): Account {
    if (!this.account || this.account.loginRequired) throw new AppError("xiaoheihe_login_required", { effect: "none" });
    return this.account;
  }

  connect(): Promise<void> {
    return this.serialized(() => this.connectAccount());
  }

  async stop(): Promise<void> {
    this.disposed = true;
    await this.serialized(() => this.disconnectAccount());
  }

  private async connectAccount(): Promise<void> {
    if (this.disposed) return;
    this.state = "connecting";
    let store: AccountStore | undefined;
    let api: ReturnType<typeof createXiaoheiheApi> | undefined;
    try {
      const session = await loadSession(this.sessionFile);
      if (!session) {
        this.log.warn("account.login_required", { file: this.sessionFile });
        throw new AppError("authentication_required", { effect: "none" });
      }
      if (session.user_id !== this.config.selfId) throw new AppError("account_identity_mismatch", { effect: "none" });
      store = await AccountStore.open(this.directory, this.config.selfId, { clock: this.clock });
      // Persist refreshed cookies in order; a failed write keeps the previous session file.
      let saving = Promise.resolve();
      const persist = (cookies: StoredCookie[]) => {
        saving = saving.then(() => saveSession(this.sessionFile, { user_id: this.config.selfId, cookies }).catch(() => {}));
      };
      api = createXiaoheiheApi(new HeyboxHttp(session.cookies, { onCookies: persist, clock: this.clock }), this.config.selfId, this.clock);
      const account = new Account(this.config, api, store, this.clock);
      this.account = account;
      await account.checkIdentity();
      // A fresh session (copied or scanned) proves the login again; lift only the pauses it can cure.
      const paused = account.store.snapshot().paused;
      if (paused === "authentication_required" || paused === "operator") await account.resume();
      await account.recordActivity({ kind: "connect", outcome: "ok" });
      this.state = "connected";
      this.log.info("account.connected", { paused: account.store.snapshot().paused !== null });
      // One read-only look at publications whose result was uncertain; nothing else runs on its own.
      void account.reconcileUncertain().catch(() => {});
    } catch (error) {
      const code = CONNECT_ERRORS.includes(errorCodeOf(error)) ? errorCodeOf(error) : "connection_failed";
      this.log.warn("account.connect_failed", { code });
      await store?.recordActivity({ kind: "connect", outcome: "failed", errorCode: "connection_failed" }).catch(() => {});
      if (this.account) await this.account.stop();
      else {
        await api?.close();
        await store?.close();
      }
      this.account = undefined;
      this.state = code === "authentication_required" ? "login_required" : "error";
    }
  }

  private async disconnectAccount(): Promise<void> {
    await this.account?.stop();
    this.account = undefined;
  }

  /** Starts the QR login; poll `status().login` for the image and the outcome. */
  async startWebLogin(): Promise<void> {
    if (this.webLogin.state === "pending") return;
    this.webLogin = { state: "pending" };
    void this.qrLogin()
      .then((message) => {
        this.webLogin = { state: "finished", message };
      })
      .catch(() => {
        this.webLogin = { state: "finished", message: "登录失败，请稍后重试" };
      });
  }

  /** QR login against the web API; on success saves the session and reconnects. */
  private async qrLogin(): Promise<string> {
    try {
      const http = new HeyboxHttp([], { clock: this.clock });
      const qr = record((await http.request("/account/get_qrcode_url/", { params: { app: "web" } })).result);
      const url = typeof qr.qr_url === "string" ? qr.qr_url : "";
      const token = url ? new URL(url).searchParams.get("qr") : null;
      if (!token) return "获取登录二维码失败";
      this.webLogin.image = `data:image/png;base64,${(await toBuffer(url, { margin: 2, width: 360 })).toString("base64")}`;
      const deadline = this.clock.now() + 180_000;
      while (this.clock.now() < deadline && !this.disposed) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const response = await http.request("/account/qr_state/", { params: { app: "web", qr: token } });
        const state = record(response.result ?? {});
        if (state.error === "wait" || state.error === "ready") continue;
        if (state.error !== "ok") return "二维码已失效，请重新扫码登录";
        const userId = identity(response);
        if (userId !== this.config.selfId) return `扫码账号 ${userId} 与配置的 selfId 不一致，未保存`;
        const cookies = normalizeCookies(http.cookies(), { ...state, heybox_id: userId });
        if ((await createXiaoheiheApi(new HeyboxHttp(cookies, { clock: this.clock }), userId, this.clock).login()).userId !== userId)
          return "登录校验失败，未保存";
        await saveSession(this.sessionFile, { user_id: userId, cookies });
        await this.serialized(async () => {
          await this.disconnectAccount();
          await this.connectAccount();
        });
        return this.account ? "小黑盒登录成功" : "登录已保存，但连接失败，请查看日志";
      }
      return "等待扫码超时，未保存";
    } catch {
      return "登录失败，请稍后重试";
    }
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = accountLifecycles.get(this.directory) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    accountLifecycles.set(this.directory, current);
    void current
      .finally(() => {
        if (accountLifecycles.get(this.directory) === current) accountLifecycles.delete(this.directory);
      })
      .catch(() => {});
    return current;
  }
}
