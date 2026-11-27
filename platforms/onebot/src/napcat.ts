import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { contentHash, httpFetch, logger, serialize, systemClock, type Clock } from "@yesimbot/foundation";
import { toDataURL } from "qrcode";

const UNAVAILABLE = "NapCat is unavailable or its WebUI authentication needs attention.";
const QR_FAILED = "Cannot obtain QQ login QR code. Check NapCat availability and WebUI credentials.";
const QR_NOT_READY = "QR code is not ready. Refresh it after NapCat finishes starting.";
const QR_OPTIONS = { errorCorrectionLevel: "M", width: 320, margin: 2 } as const;
/** RefreshQRcode only asks QQ for a new code; the code itself arrives a moment later. */
const QR_REFRESH_WAIT_MS = 6000;
const QR_REFRESH_POLL_MS = 300;
/** QQ answers a password, captcha or device login only after its own server round trip. */
const LOGIN_TIMEOUT_MS = 30_000;
const LOGIN_TTL_MS = 10 * 60_000;
/** Captcha app id NapCat's own WebUI falls back to when QQ's link omits `aid`. */
const QQ_CAPTCHA_APP = "2081081773";
const napcatClock: NapCatClock = { ...systemClock(), wait: (ms) => new Promise((done) => setTimeout(done, ms)) };
const log = logger("onebot.napcat");

/**
 * One step of a QQ password login. `submitted` means QQ accepted the request; the login
 * itself is confirmed by the status poll. Failure messages are short QQ server texts.
 */
export type NapCatLoginStep =
  | { step: "submitted" }
  | { step: "captcha"; captcha: NapCatCaptcha }
  | { step: "device"; image: string; scanned?: boolean }
  | { step: "failed"; reason: "rejected" | "expired" | "device"; message?: string };

type RecordValue = Record<string, unknown>;

type NapCatRequestPath =
  | "QQLogin/CheckLoginStatus"
  | "QQLogin/GetQQLoginInfo"
  | "QQLogin/GetQQLoginQrcode"
  | "QQLogin/RefreshQRcode"
  | "QQLogin/RestartNapCat"
  | "QQLogin/SetQuickLoginQQ"
  | "QQLogin/PasswordLogin"
  | "QQLogin/CaptchaLogin"
  | "QQLogin/NewDeviceLogin"
  | "QQLogin/GetNewDeviceQRCode"
  | "QQLogin/PollNewDeviceQR";

/** Where NapCat's WebUI listens and where it keeps its credential. */
export interface NapCatConfig {
  endpoint: string;
  webuiConfigFile: string;
}

export interface NapCatStatus {
  available: boolean;
  loggedIn: boolean;
  /** QQ accepted the login and NapCat is still bringing the account online. */
  connecting?: boolean;
  accountId?: string;
  nickname?: string;
  uid?: string;
  online?: boolean;
  avatarUrl?: string;
  /** Names NapCat's current login QR code while logged out; it changes whenever NapCat issues a new code. */
  qrId?: string;
  /** Seconds since this host first saw that code. NapCat replaces an expired code by itself, so an old one is a dead one. */
  qrAge?: number;
  /** Why the last login ended, as a fixed category; upstream text is never forwarded. */
  loginProblem?: "kicked" | "failed";
  message?: string;
}

export interface NapCatQrCode {
  image?: string;
  /** Same value as `NapCatStatus.qrId` for the code in `image`. */
  id?: string;
  qrCode?: string;
  url?: string;
  message?: string;
}

export interface NapCatLogout {
  accepted: true;
  message: string;
}

/** Parameters for Tencent's captcha widget, taken from QQ's verification link. */
export interface NapCatCaptcha {
  appId: string;
  sid?: string;
  uin?: string;
  loginAppId?: string;
}

export interface NapCatClock extends Clock {
  wait(ms: number): Promise<void>;
}

/** A password login waiting for a captcha or a new-device confirmation. Lives only in memory. */
interface PendingLogin {
  uin: string;
  passwordMd5: string;
  expiresAt: number;
  sid?: string;
  device?: { jumpUrl: string; sig: string; token: string; image: string };
}

export class NapCatGateway {
  private endpoint: string;
  private token?: string;
  private logoutPending?: Promise<NapCatLogout>;
  private refreshPending?: Promise<NapCatQrCode>;
  private login?: PendingLogin;
  /** The login code last read from NapCat and when it was first seen; only its hash is kept. */
  private qrSeen?: { id: string; since: number };
  /** QQ was seen signed out since the last quick-login change: the next sign-in seen becomes the quick login. */
  private signedOutSeen = false;
  constructor(
    private config: NapCatConfig,
    private fetcher: typeof httpFetch = httpFetch,
    private clock: NapCatClock = napcatClock,
  ) {
    const url = new URL(config.endpoint);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("NapCat endpoint must be a loopback HTTP origin.");
    this.endpoint = url.origin;
  }
  private async post(path: string, body: unknown, token?: string, timeout = 8000): Promise<RecordValue> {
    const response = await this.fetcher(`${this.endpoint}/api/${path}`, {
      purpose: "internal",
      method: "POST",
      timeoutMs: timeout,
      maxBytes: 4 * 1024 * 1024,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("NapCat request failed");
    return record(await response.json());
  }
  private async authenticate(): Promise<string> {
    if (this.token) return this.token;
    const config = record(JSON.parse(await readFile(this.config.webuiConfigFile, "utf8")));
    if (typeof config.token !== "string" || !config.token) throw new Error("NapCat credential unavailable");
    const hash = contentHash(config.token + ".napcat");
    const result = await this.post("auth/login", { hash });
    const auth = record(result.code === 0 ? result.data : undefined);
    this.token = text(auth.Credential) ?? text(auth.token);
    if (!this.token) throw new Error("NapCat authentication failed");
    return this.token;
  }
  private async request(path: NapCatRequestPath, body: Record<string, string> = {}, timeout?: number): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.authenticate();
      let result: RecordValue;
      try {
        result = await this.post(path, body, token, timeout);
      } catch {
        this.token = undefined;
        throw new Error(UNAVAILABLE);
      }
      if (result.code === 0) return result.data;
      const reason = text(result.message) ?? "";
      if (!/^Unauthorized$/i.test(reason)) throw new NapCatRejected(reason);
      // NapCat credentials last an hour and are then refused with HTTP 200; the handler never ran, so one retry is safe.
      this.token = undefined;
      if (attempt > 0) throw new Error(UNAVAILABLE);
    }
  }
  /** Whether the signed-in account is offline. Reads only the login state; never touches a QR login. */
  async presence(): Promise<{ offline: boolean; accountId?: string }> {
    const data = record(await this.request("QQLogin/CheckLoginStatus"));
    if (data.isOffline !== true) return { offline: false };
    const account = record(await this.request("QQLogin/GetQQLoginInfo").catch(() => undefined));
    return { offline: true, accountId: text(account.uin) };
  }
  async status(): Promise<NapCatStatus> {
    try {
      const data = record(await this.request("QQLogin/CheckLoginStatus"));
      if (data.isLogin === true || data.isOffline === true) return await this.account(data.isOffline === true);
      // CheckLoginStatus waits for the account to come online; the QR call already refuses once QQ accepted the scan.
      const current = await this.currentQr();
      if (current.loggedIn) return await this.account();
      this.signedOutSeen = true;
      const problem = loginProblem(text(data.loginError));
      const seen = current.source ? this.seeQr(qrId(current.source)) : undefined;
      return {
        available: true,
        loggedIn: false,
        online: false,
        ...(seen ? { qrId: seen.id, qrAge: Math.floor((this.clock.now() - seen.since) / 1000) } : {}),
        ...(problem ? { loginProblem: problem } : {}),
      };
    } catch {
      return { available: false, loggedIn: false, message: "Cannot reach NapCat. Check its process, WebUI configuration and server-side credentials." };
    }
  }
  /** `offline` is undefined while QQ has accepted a login but NapCat has not reported the account online yet. */
  private async account(offline?: boolean): Promise<NapCatStatus> {
    const status: NapCatStatus = {
      available: true,
      loggedIn: true,
      ...(offline === undefined ? { connecting: true } : {}),
      ...(offline ? { online: false, message: "QQ is logged in but currently offline." } : {}),
    };
    try {
      const account = record(await this.request("QQLogin/GetQQLoginInfo"));
      const accountId = text(account.uin);
      if (offline === false && accountId) await this.rememberLogin(accountId);
      return {
        ...status,
        accountId,
        nickname: text(account.nick),
        uid: text(account.uid),
        online: offline ? false : typeof account.online === "boolean" ? account.online : undefined,
        avatarUrl: accountId && /^[1-9]\d{0,19}$/.test(accountId) ? `https://q1.qlogo.cn/g?b=qq&nk=${accountId}&s=140` : undefined,
      };
    } catch {
      if (offline === undefined) return status;
      return {
        ...status,
        message: offline ? "QQ is offline. Account details are temporarily unavailable." : "QQ is logged in. Account details are temporarily unavailable.",
      };
    }
  }
  /** NapCat's current login QR source, or `loggedIn` once QQ has accepted a login. */
  private async currentQr(): Promise<{ loggedIn: boolean; source?: string }> {
    try {
      return { loggedIn: false, source: qrSource(await this.request("QQLogin/GetQQLoginQrcode")) };
    } catch (error) {
      if (error instanceof NapCatRejected) return { loggedIn: /QQ Is Logined/i.test(error.reason) };
      throw error;
    }
  }
  /**
   * NapCat signs in by itself after a restart only as WebUI quick login (`autoLoginAccount`) or its quick-login
   * environment, and a QR or password login sets neither; so a sign-in this console watched becomes the quick login.
   * Only after QQ was seen signed out: a status read between a logout's clearing and NapCat's restart must not set it back.
   */
  private async rememberLogin(accountId: string): Promise<void> {
    if (!this.signedOutSeen || this.logoutPending) return;
    try {
      await this.request("QQLogin/SetQuickLoginQQ", { uin: accountId });
      this.signedOutSeen = false;
      log.info("quick_login.set");
    } catch (error) {
      // The next status read tries again.
      log.warn("quick_login.failed", { reason: error instanceof NapCatRejected ? "rejected" : "unavailable" });
    }
  }
  logout(): Promise<NapCatLogout> {
    if (this.logoutPending) return this.logoutPending;
    this.signedOutSeen = false;
    this.logoutPending = (async () => {
      const marker = join(dirname(this.config.webuiConfigFile), "yesimbot-logged-out");
      try {
        // The pinned NapCat worker restart omits its initial -q account argument.
        // Clearing WebUI quick login first prevents it from signing in again.
        await this.request("QQLogin/SetQuickLoginQQ", { uin: "" });
        try {
          await writeFile(marker, "{}\n", { flag: "wx", mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        // Keep explicit logout intent even if the restart acknowledgement is lost.
        await this.request("QQLogin/RestartNapCat");
        return { accepted: true as const, message: "QQ logout requested. Wait for NapCat to reconnect and confirm its login state." };
      } catch {
        throw new Error("Cannot request QQ logout. Check NapCat availability and server-side configuration.");
      } finally {
        this.logoutPending = undefined;
      }
    })();
    return this.logoutPending;
  }
  /** Records a code NapCat reports; a replacement is logged with how long the previous code lived (no code material). */
  private seeQr(id: string): { id: string; since: number } {
    if (this.qrSeen?.id === id) return this.qrSeen;
    const now = this.clock.now();
    if (this.qrSeen) log.info("qr.replaced", { previousAgeSeconds: Math.round((now - this.qrSeen.since) / 1000) });
    this.qrSeen = { id, since: now };
    return this.qrSeen;
  }
  async qrcode(): Promise<NapCatQrCode> {
    try {
      const current = await this.currentQr();
      return current.source ? await encodeQr(current.source) : { message: current.loggedIn ? "QQ is already logged in." : QR_NOT_READY };
    } catch {
      return { message: QR_FAILED };
    }
  }
  /** Asks NapCat for a new code and waits until it differs from the old one; concurrent calls share one refresh. */
  refreshQr(): Promise<NapCatQrCode> {
    if (this.refreshPending) return this.refreshPending;
    this.refreshPending = (async () => {
      try {
        const before = (await this.currentQr()).source;
        await this.request("QQLogin/RefreshQRcode");
        const deadline = this.clock.now() + QR_REFRESH_WAIT_MS;
        for (;;) {
          await this.clock.wait(QR_REFRESH_POLL_MS);
          const current = await this.currentQr();
          if (current.loggedIn) return { message: "QQ is already logged in." };
          if (current.source && current.source !== before) {
            log.info("qr.refreshed", { renewed: true });
            this.seeQr(qrId(current.source));
            return await encodeQr(current.source);
          }
          if (this.clock.now() >= deadline) {
            log.warn("qr.refreshed", { renewed: false, hasCode: !!current.source });
            return current.source ? { ...(await encodeQr(current.source)), message: "NapCat has not issued a new QR code yet." } : { message: QR_NOT_READY };
          }
        }
      } catch {
        return { message: QR_FAILED };
      } finally {
        this.refreshPending = undefined;
      }
    })();
    return this.refreshPending;
  }
  /** Starts a password login. The password is hashed here, as NapCat expects, and kept only for the follow-up steps. */
  passwordLogin(uin: string, password: string): Promise<NapCatLoginStep> {
    return serialize(`napcat-login:${this.endpoint}`, () => {
      const pending: PendingLogin = { uin, passwordMd5: createHash("md5").update(password, "utf8").digest("hex"), expiresAt: this.clock.now() + LOGIN_TTL_MS };
      this.login = pending;
      return this.advance(pending, () => this.request("QQLogin/PasswordLogin", { uin, passwordMd5: pending.passwordMd5 }, LOGIN_TIMEOUT_MS));
    });
  }
  captchaLogin(ticket: string, randstr: string): Promise<NapCatLoginStep> {
    return serialize(`napcat-login:${this.endpoint}`, async () => {
      const pending = this.pendingLogin();
      const sid = pending?.sid;
      if (!pending || sid === undefined) return { step: "failed", reason: "expired" };
      const { uin, passwordMd5 } = pending;
      return this.advance(pending, () => this.request("QQLogin/CaptchaLogin", { uin, passwordMd5, ticket, randstr, sid }, LOGIN_TIMEOUT_MS));
    });
  }
  /** Checks the new-device confirmation and finishes the login once the phone confirms; `renew` fetches a fresh code. */
  deviceLogin(renew = false): Promise<NapCatLoginStep> {
    return serialize(`napcat-login:${this.endpoint}`, async () => {
      const pending = this.pendingLogin();
      const device = pending?.device;
      if (!pending || !device) return { step: "failed", reason: "expired" };
      if (renew) return this.deviceQr(pending, device.jumpUrl, device.sig);
      let poll: RecordValue;
      try {
        poll = record(await this.request("QQLogin/PollNewDeviceQR", { uin: pending.uin, bytesToken: device.token }));
      } catch (error) {
        if (error instanceof NapCatRejected) return { step: "device", image: device.image };
        throw error;
      }
      const state = Number(poll.uint32_guarantee_status);
      if (state !== 1) return { step: "device", image: device.image, ...(state === 3 ? { scanned: true } : {}) };
      const newDevicePullQrCodeSig = text(poll.str_nt_succ_token) || device.sig;
      const { uin, passwordMd5 } = pending;
      return this.advance(pending, () => this.request("QQLogin/NewDeviceLogin", { uin, passwordMd5, newDevicePullQrCodeSig }, LOGIN_TIMEOUT_MS));
    });
  }
  cancelLogin(): Promise<void> {
    return serialize(`napcat-login:${this.endpoint}`, async () => {
      this.login = undefined;
    });
  }
  private pendingLogin(): PendingLogin | undefined {
    if (this.login && this.login.expiresAt <= this.clock.now()) this.login = undefined;
    return this.login;
  }
  private finish(pending: PendingLogin) {
    if (this.login === pending) this.login = undefined;
  }
  /** Maps NapCat's answer to the next step. An unreachable NapCat throws and keeps the pending login for a retry. */
  private async advance(pending: PendingLogin, call: () => Promise<unknown>): Promise<NapCatLoginStep> {
    let data: RecordValue;
    try {
      data = record(await call());
    } catch (error) {
      if (!(error instanceof NapCatRejected)) throw error;
      this.finish(pending);
      if (/QQ Is Logined/i.test(error.reason)) return { step: "submitted" };
      const message = qqMessage(error.reason);
      return { step: "failed", reason: "rejected", ...(message ? { message } : {}) };
    }
    const proof = text(data.proofWaterUrl);
    if (data.needCaptcha === true && proof) {
      const captcha = captchaParams(proof);
      if (!captcha) {
        this.finish(pending);
        return { step: "failed", reason: "rejected" };
      }
      pending.sid = captcha.sid ?? "";
      pending.device = undefined;
      return { step: "captcha", captcha };
    }
    const jumpUrl = text(data.jumpUrl);
    if (data.needNewDevice === true && jumpUrl) return this.deviceQr(pending, jumpUrl, text(data.newDevicePullQrCodeSig) ?? "");
    this.finish(pending);
    return { step: "submitted" };
  }
  /** QQ asks to confirm a new device: NapCat fetches the confirmation code, which is encoded here like the login QR. */
  private async deviceQr(pending: PendingLogin, jumpUrl: string, sig: string): Promise<NapCatLoginStep> {
    let data: RecordValue = {};
    try {
      data = record(await this.request("QQLogin/GetNewDeviceQRCode", { uin: pending.uin, jumpUrl }));
    } catch (error) {
      if (!(error instanceof NapCatRejected)) throw error;
    }
    const url = normalizeQrCode(text(data.str_url)).url;
    const token = text(data.bytes_token) || deviceToken(url);
    if (!url || !token) {
      this.finish(pending);
      return { step: "failed", reason: "device" };
    }
    const image = await toDataURL(url, QR_OPTIONS);
    pending.sid = undefined;
    pending.device = { jumpUrl, sig, token, image };
    return { step: "device", image };
  }
}

/** NapCat answered the call with `code != 0`; `reason` is its raw message and is never forwarded as is. */
class NapCatRejected extends Error {
  constructor(readonly reason: string) {
    super("NapCat request rejected");
  }
}

export function normalizeQrCode(value: unknown): NapCatQrCode {
  const qr = qrSource(value);
  if (!qr) return { message: QR_NOT_READY };
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(qr)) return { image: qr };
  if (/^https?:\/\//.test(qr)) {
    try {
      const url = new URL(qr);
      if (qr.length <= 2048 && !url.username && !url.password) return { url: qr, qrCode: qr };
    } catch {
      /* Invalid QR URL. */
    }
  }
  if (/^[A-Za-z0-9+/=]+$/.test(qr) && qr.length > 100) return { image: `data:image/png;base64,${qr}` };
  return { message: "NapCat returned an unsupported QR code format." };
}

function qrSource(value: unknown): string | undefined {
  const data = record(value);
  return text(value) ?? text(data.qrcode) ?? text(data.qrCode) ?? text(data.qrcodeurl) ?? text(data.image) ?? text(data.url);
}

/** Short, stable name for one QR code, so pages can tell a new code from the one they show. */
function qrId(source: string): string {
  return contentHash(source, { hexLength: 16 });
}

async function encodeQr(source: string): Promise<NapCatQrCode> {
  const result = normalizeQrCode(source);
  if (result.url) return { image: await toDataURL(result.url, QR_OPTIONS), id: qrId(source) };
  return result.image ? { image: result.image, id: qrId(source) } : result;
}

/**
 * NapCat keeps its last login error until the next attempt. An expired code is replaced automatically,
 * so only a forced logout and other failures are reported, as categories.
 */
function loginProblem(error?: string): NapCatStatus["loginProblem"] {
  if (!error || (/二维码/.test(error) && /过期|失效/.test(error))) return undefined;
  return error.startsWith("[KickedOffLine]") ? "kicked" : "failed";
}

/** QQ's own explanation of a refused login (wrong password, frozen account), kept only when it is a short Chinese sentence. */
function qqMessage(reason: string): string | undefined {
  const line = reason.replace(/\p{Cc}+/gu, " ").trim();
  return line.length <= 120 && /[一-鿿]/.test(line) && !/[A-Za-z0-9+/=_-]{24,}/.test(line) ? line : undefined;
}

function captchaParams(proofWaterUrl: string): NapCatCaptcha | undefined {
  let query: URLSearchParams;
  try {
    query = new URL(proofWaterUrl).searchParams;
  } catch {
    return undefined;
  }
  const appId = query.get("aid") || QQ_CAPTCHA_APP;
  if (!/^\d{1,12}$/.test(appId)) return undefined;
  const pick = (name: string) => {
    const value = query.get(name);
    return value && value.length <= 512 && /^[\x21-\x7e]+$/.test(value) ? value : undefined;
  };
  const captcha: NapCatCaptcha = { appId };
  const sid = pick("sid");
  const uin = pick("uin");
  const loginAppId = pick("login_appid");
  if (sid) captcha.sid = sid;
  if (uin) captcha.uin = uin;
  if (loginAppId) captcha.loginAppId = loginAppId;
  return captcha;
}

/** NapCat's WebUI derives the poll token from the code link when QQ omits `bytes_token`. */
function deviceToken(url?: string): string | undefined {
  if (!url) return undefined;
  const inner = new URL(url).searchParams.get("str_url");
  return inner ? Buffer.from(inner, "latin1").toString("base64") : undefined;
}

function record(value: unknown): RecordValue {
  return value && typeof value === "object" ? (value as RecordValue) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 2_000_000 ? value : undefined;
}
