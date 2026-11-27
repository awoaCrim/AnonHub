import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { newId, writeFileAtomic } from "@yesimbot/foundation";
import { AgentWechatClient, AgentWechatError, readTokenFile, type AgentWechatAccount, type AgentWechatOperation } from "@yesimbot/wechat-transport";

import type { AdminAuth, AdminHttpContext } from "./admin-auth.js";
import type { Host } from "./host.js";
import type { WechatLoginAttempt, WechatLoginStatus, WechatQrCode } from "./shared/wechat.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired", "rejected", "needs_login"]);

export interface WechatLoginConfig {
  enabled: boolean;
  /** The daemon's loopback address inside the runtime container. */
  endpoint: string;
  /** Its owner token, relative to the Koishi base directory. Read only by the server. */
  tokenFile: string;
  /** The daemon account the WeChat adapter speaks for. */
  account: string;
}

/**
 * Signs the bot's WeChat account in and out. The daemon has no list of running logins, so the one this console
 * started is remembered in a file: a console restart can still show its QR code.
 */
export class WechatLoginGateway {
  private starting?: Promise<WechatLoginStatus>;
  public constructor(
    private readonly api: AgentWechatClient,
    private readonly account: string,
    private readonly stateFile: string,
  ) {}

  public async status(): Promise<WechatLoginStatus> {
    let account: AgentWechatAccount | undefined;
    try {
      account = await this.api.findAccount(this.account);
    } catch {
      return { available: false, loggedIn: false, online: false };
    }
    const loggedIn = !!account?.authenticated && !!account.ownUsername;
    const status: WechatLoginStatus = {
      available: true,
      loggedIn,
      online: loggedIn && account?.connection === "online",
      ...(account?.ownUsername ? { accountId: account.ownUsername } : {}),
    };
    const operation = account && !loggedIn ? await this.operation(account.id) : undefined;
    return operation ? { ...status, login: attempt(operation) } : status;
  }

  /** Starts a login unless one is already waiting. Creates the daemon account the first time. */
  public start(): Promise<WechatLoginStatus> {
    this.starting ??= this.begin().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  public async qr(generation?: number): Promise<WechatQrCode | undefined> {
    const account = await this.api.findAccount(this.account);
    const operation = account ? await this.operation(account.id) : undefined;
    if (!account || !operation) return undefined;
    const current = attempt(operation).qrGeneration;
    if (current === undefined || (generation !== undefined && generation !== current)) return undefined;
    const png = await this.api.qr(account.id, operation.id, current);
    return { image: `data:image/png;base64,${Buffer.from(png).toString("base64")}`, generation: current };
  }

  public async cancel(): Promise<void> {
    const account = await this.api.findAccount(this.account);
    const operation = account ? await this.operation(account.id) : undefined;
    if (account && operation && !TERMINAL.has(operation.state)) await this.api.cancelOperation(account.id, operation.id);
  }

  public async logout(): Promise<void> {
    const account = await this.api.findAccount(this.account);
    if (!account) return;
    await this.api.logout(account.id, `yesimbot-logout:${newId()}`);
    await this.remember(undefined);
  }

  private async begin(): Promise<WechatLoginStatus> {
    let account = await this.api.findAccount(this.account);
    if (!account) {
      try {
        await this.api.createAccount(this.account);
      } catch (error) {
        if (!(error instanceof AgentWechatError && error.code === "account_alias_conflict")) throw error;
      }
      account = await this.api.findAccount(this.account);
      if (!account) throw new Error("wechat_account_unavailable");
    }
    if (account.authenticated) return this.status();
    const running = await this.operation(account.id);
    if (!running || TERMINAL.has(running.state)) {
      const operation = await this.api.login(account.id, `yesimbot-login:${newId()}`);
      await this.remember(operation.id);
    }
    return this.status();
  }

  private async operation(account: string): Promise<AgentWechatOperation | undefined> {
    const id = await this.recalled();
    if (!id) return undefined;
    try {
      const operation = await this.api.operation(account, id);
      return operation.kind === "login" ? operation : undefined;
    } catch (error) {
      // Expired or from a reset daemon: forget it.
      if (error instanceof AgentWechatError && (error.status === 404 || error.status === 410)) await this.remember(undefined);
      return undefined;
    }
  }

  private async recalled(): Promise<string | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.stateFile, "utf8"));
      const id = value && typeof value === "object" ? (value as { operation?: unknown }).operation : undefined;
      return typeof id === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(id) ? id : undefined;
    } catch {
      return undefined;
    }
  }

  private async remember(operation: string | undefined): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.stateFile, JSON.stringify(operation ? { operation } : {}) + "\n", { mode: 0o600 });
  }
}

export function installWechatLogin(ctx: Host, config: WechatLoginConfig, auth: AdminAuth): void {
  if (!config.enabled) return;
  const tokenFile = resolve(ctx.baseDir, config.tokenFile);
  const api = new AgentWechatClient({ endpoint: config.endpoint, token: () => readTokenFile(tokenFile), timeoutMs: 15_000 });
  const gateway = new WechatLoginGateway(api, config.account, resolve(ctx.baseDir, "data/console-admin/wechat-login.json"));
  const allowed = (http: AdminHttpContext, write = false) => {
    if (!auth.requireOwner(http)) return false;
    if (write && !auth.sameOrigin(http)) {
      http.status = 403;
      http.body = { message: "Same-origin request required." };
      return false;
    }
    return true;
  };
  const unavailable = (http: AdminHttpContext) => {
    http.status = 502;
    http.body = { message: "微信服务暂时不可用" };
  };
  ctx.server.get("/yesimbot/wechat/status", async (http) => {
    if (allowed(http)) http.body = await gateway.status();
  });
  ctx.server.post("/yesimbot/wechat/login", async (http) => {
    if (!allowed(http, true)) return;
    try {
      http.body = await gateway.start();
    } catch (error) {
      if (error instanceof AgentWechatError && error.code === "operation_in_progress") {
        http.status = 409;
        http.body = { message: "已有一次登录正在进行" };
      } else unavailable(http);
    }
  });
  ctx.server.get("/yesimbot/wechat/qrcode", async (http) => {
    if (!allowed(http)) return;
    const raw = http.query.generation;
    const generation = typeof raw === "string" && /^[0-9]{1,6}$/.test(raw) ? Number(raw) : undefined;
    try {
      const code = await gateway.qr(generation);
      if (code) http.body = code;
      else {
        http.status = 404;
        http.body = { message: "二维码暂未就绪" };
      }
    } catch {
      unavailable(http);
    }
  });
  ctx.server.post("/yesimbot/wechat/login/cancel", async (http) => {
    if (!allowed(http, true)) return;
    try {
      await gateway.cancel();
      http.body = await gateway.status();
    } catch {
      unavailable(http);
    }
  });
  ctx.server.post("/yesimbot/wechat/logout", async (http) => {
    if (!allowed(http, true)) return;
    try {
      await gateway.logout();
      http.status = 202;
      http.body = { accepted: true };
    } catch {
      unavailable(http);
    }
  });
}

function attempt(operation: AgentWechatOperation): WechatLoginAttempt {
  const result = operation.result ?? {};
  const waiting = operation.state === "awaiting_scan" || operation.state === "awaiting_approval";
  const problem =
    operation.state === "expired" || operation.state === "cancelled"
      ? "expired"
      : operation.state === "rejected"
        ? "rejected"
        : operation.state === "failed" || operation.state === "needs_login"
          ? result.code === "login_lan_challenge_failed"
            ? "lan"
            : "failed"
          : undefined;
  return {
    state: operation.state,
    ...(waiting && result.qrAvailable === true && Number.isSafeInteger(result.qrGeneration) ? { qrGeneration: result.qrGeneration as number } : {}),
    ...(waiting && typeof result.lanChallenge === "string" && result.lanChallenge ? { lan: true } : {}),
    ...(problem ? { problem } : {}),
  };
}
