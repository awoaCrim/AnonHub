import { reactive } from "vue";

import type { NapCatLogout, NapCatQrCode, NapCatStatus } from "../../../src/shared/napcat";
import { adminRequest } from "../lib/admin-request";

/** `base` is the API under `/yesimbot/`: the local NapCat by default, or a friend's through the manager. */
export function createNapCatState(request: typeof adminRequest = adminRequest, base = "napcat") {
  const state = reactive({
    status: undefined as NapCatStatus | undefined,
    qrCode: "",
    /** NapCat's id for `qrCode`. A different id in the status means NapCat issued a new code, e.g. after the old one expired. */
    qrId: "",
    /** A code a refresh asked to replace and NapCat kept: it is dead, and only restarting QQ brings a new one. */
    deadQrId: "",
    notice: "",
    error: "",
    /** Only actions the user started; background polls stay silent so buttons do not flicker. */
    busy: false,
    loggingOut: false,
    logoutRequested: false,
    checkedAt: 0,
  });
  let logoutDeadline = 0;
  let visible = false;
  let disposed = false;
  /** The first read may answer from the browser cache so the page renders at once; every later read must reach NapCat. */
  let primed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;

  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function schedule(delay?: number) {
    clearTimer();
    if (!visible || disposed || state.loggingOut) return;
    const settled = state.status?.loggedIn && !state.status.connecting;
    timer = setTimeout(() => void run(false, false), delay ?? (state.error || !state.status?.available || settled ? 10_000 : 2_000));
  }

  /** Returns true when the status came from the browser cache and needs a fresh read right away. */
  async function load(refreshQr: boolean): Promise<boolean> {
    if (disposed) return false;
    state.error = "";
    const fresh = primed || refreshQr;
    primed = true;
    try {
      const status = await request<NapCatStatus>(`${base}/status`, undefined, fresh ? { fresh: true } : undefined);
      if (disposed) return false;
      // An unreadable login service is not a logout: keep the last account shown until a readable answer says otherwise.
      const unreadable = !status.available && !status.loggedIn;
      state.status =
        state.logoutRequested && !status.available && state.status
          ? { ...state.status, available: false, online: false }
          : unreadable && state.status?.loggedIn
            ? { ...state.status, available: false, message: status.message }
            : status;
      if (state.logoutRequested && status.available && !status.loggedIn) state.logoutRequested = false;
      state.checkedAt = Date.now();
      if (status.loggedIn) {
        state.qrCode = "";
        state.qrId = "";
        state.deadQrId = "";
        state.notice = state.logoutRequested ? "QQ 退出请求已提交，正在等待服务恢复并确认退出。" : "";
      } else if (status.available && (refreshQr || !state.qrCode || status.qrId !== state.qrId)) {
        // Fetch the image only when NapCat reports another code; an unchanged code is never re-downloaded.
        const replaced = !refreshQr && !!state.qrCode;
        const previous = state.qrId;
        const qr = await request<NapCatQrCode>(refreshQr ? `${base}/qrcode/refresh` : `${base}/qrcode`, refreshQr ? {} : undefined);
        if (disposed) return false;
        state.qrCode = qr.image ?? "";
        state.qrId = qr.id ?? "";
        if (refreshQr && qr.message && state.qrId && state.qrId === previous) state.deadQrId = state.qrId;
        state.notice = !state.qrCode
          ? "二维码尚未就绪，请稍后重试。"
          : state.qrId === state.deadQrId
            ? ""
            : refreshQr
              ? "已换成新的二维码，请用手机 QQ 扫码。"
              : replaced
                ? "二维码已更新，请扫描新的二维码。"
                : "使用手机 QQ 扫码并确认登录，页面会自动显示账号信息。";
      }
      return !fresh;
    } catch (error) {
      if (!disposed) state.error = error instanceof Error ? error.message : "无法读取 QQ 状态，请稍后重试。";
      return false;
    } finally {
      if (!disposed && state.logoutRequested && Date.now() >= logoutDeadline) {
        state.logoutRequested = false;
        state.notice = "";
        state.error = "尚未确认 QQ 已退出，请检查服务状态后重试退出。";
      }
    }
  }

  /** Serializes reads. A plain read joins the one in flight; a QR refresh waits for it and then runs, so the click is never lost. */
  function run(refreshQr: boolean, manual: boolean): Promise<void> {
    if (disposed) return Promise.resolve();
    if (pending && !refreshQr) return pending;
    clearTimer();
    if (manual) state.busy = true;
    let cached = false;
    const operation: Promise<void> = (pending ?? Promise.resolve())
      .then(async () => {
        cached = await load(refreshQr);
      })
      .finally(() => {
        if (pending !== operation) return;
        pending = undefined;
        if (!disposed && !state.loggingOut) state.busy = false;
        schedule(cached ? 0 : undefined);
      });
    pending = operation;
    return operation;
  }

  function refresh(refreshQr = false): Promise<void> {
    return run(refreshQr, true);
  }

  function logout(): Promise<void> {
    if (disposed || state.loggingOut || state.logoutRequested || !state.status?.loggedIn) return pending ?? Promise.resolve();
    clearTimer();
    state.loggingOut = true;
    state.busy = true;
    const operation: Promise<void> = Promise.resolve(pending)
      .then(async () => {
        if (disposed) return;
        state.busy = true;
        state.error = "";
        try {
          const result = await request<NapCatLogout>(`${base}/logout`, {});
          if (disposed) return;
          if (result.accepted !== true) throw new Error("Logout was not accepted");
          state.logoutRequested = true;
          logoutDeadline = Date.now() + 60_000;
          state.qrCode = "";
          state.qrId = "";
          state.notice = "QQ 退出请求已提交，正在检查登录状态。";
          await load(false);
        } catch {
          if (!disposed) state.error = "无法退出 QQ，请检查连接后重试。";
        }
      })
      .finally(() => {
        if (pending === operation) pending = undefined;
        if (!disposed) {
          state.loggingOut = false;
          state.busy = false;
        }
        schedule();
      });
    pending = operation;
    return operation;
  }

  function setVisible(value: boolean): Promise<void> {
    visible = value;
    clearTimer();
    return visible && !disposed ? refresh() : Promise.resolve();
  }

  function dispose() {
    disposed = true;
    visible = false;
    clearTimer();
    state.busy = false;
  }

  return { state, refresh, logout, setVisible, dispose };
}
