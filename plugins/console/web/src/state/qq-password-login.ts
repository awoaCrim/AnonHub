import { reactive } from "vue";

import type { NapCatLoginStep } from "../../../src/shared/napcat";
import { adminRequest } from "../lib/admin-request";
import { solveTencentCaptcha, type CaptchaSolver } from "../lib/tencent-captcha";

const DEVICE_POLL_MS = 2500;
const DEVICE_RETRY_MS = 5000;

export type PasswordLoginPhase = "form" | "submitting" | "captcha" | "device" | "submitted";

/**
 * QQ password login: password, then whatever QQ asks for (a captcha, a new-device confirmation on the phone).
 * The server keeps the pending login; this only walks the steps. Success is confirmed by the QQ status poll.
 */
export function createQQPasswordLogin(request: typeof adminRequest = adminRequest, solveCaptcha: CaptchaSolver = solveTencentCaptcha, base = "napcat") {
  const state = reactive({
    phase: "form" as PasswordLoginPhase,
    deviceImage: "",
    scanned: false,
    notice: "",
    error: "",
  });
  /** Each attempt gets a number; results of an attempt the user cancelled or replaced are dropped. */
  let attempt = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const current = (run: number) => run === attempt && !disposed;

  function stopPolling() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function show(phase: PasswordLoginPhase, notice = "", error = "") {
    stopPolling();
    state.phase = phase;
    state.notice = notice;
    state.error = error;
    if (phase !== "device") {
      state.deviceImage = "";
      state.scanned = false;
    }
  }

  async function send(path: "password" | "captcha" | "device", body: object, run: number): Promise<void> {
    let step: NapCatLoginStep;
    try {
      step = await request<NapCatLoginStep>(`${base}/login/${path}`, body);
    } catch (error) {
      if (!current(run)) return;
      // A dropped poll must not end a verification the phone may still be confirming.
      if (path === "device" && state.phase === "device") {
        state.notice = "网络不稳定，正在重试…";
        timer = setTimeout(() => void send("device", {}, run), DEVICE_RETRY_MS);
        return;
      }
      show("form", "", error instanceof Error ? error.message : "无法完成登录，请稍后重试。");
      return;
    }
    if (current(run)) await apply(step, run);
  }

  async function apply(step: NapCatLoginStep, run: number): Promise<void> {
    if (step.step === "submitted") {
      show("submitted", "QQ 已接受登录，正在完成连接，成功后本页会自动显示账号信息。");
      return;
    }
    if (step.step === "device") {
      show("device", step.scanned ? "已扫码，请在手机上确认登录。" : "QQ 需要确认这是你的新设备：请用已登录这个 QQ 的手机扫码并确认。");
      state.deviceImage = step.image;
      state.scanned = !!step.scanned;
      timer = setTimeout(() => void send("device", {}, run), DEVICE_POLL_MS);
      return;
    }
    if (step.step === "captcha") {
      show("captcha", "QQ 要求完成一次安全验证，请在弹出的窗口中操作。");
      const solved = await solveCaptcha(step.captcha).catch(() => undefined);
      if (!current(run)) return;
      if (!solved) {
        attempt++;
        void request(`${base}/login/cancel`, {}).catch(() => undefined);
        show("form", "已取消安全验证，可以重新登录。");
        return;
      }
      show("submitting", "正在提交验证结果…");
      await send("captcha", solved, run);
      return;
    }
    show(
      "form",
      "",
      step.reason === "expired"
        ? "这次登录的验证已过期，请重新输入密码。"
        : step.reason === "device"
          ? "无法获取新设备验证码，请稍后重试，或改用扫码登录。"
          : step.message
            ? `QQ 未通过这次登录：${step.message}`
            : "登录没有成功，请检查 QQ 号和密码，或改用扫码登录。",
    );
  }

  /** The caller clears its password field right after this call. */
  function submit(uin: string, password: string): Promise<void> {
    if (disposed || state.phase === "submitting") return Promise.resolve();
    const run = ++attempt;
    show("submitting", "正在登录…");
    return send("password", { uin, password }, run);
  }

  function renewDevice(): Promise<void> {
    if (!current(attempt) || state.phase !== "device") return Promise.resolve();
    stopPolling();
    state.notice = "正在重新获取验证码…";
    return send("device", { renew: true }, attempt);
  }

  async function cancel(): Promise<void> {
    attempt++;
    show("form");
    await request(`${base}/login/cancel`, {}).catch(() => undefined);
  }

  /** Forget the flow locally, e.g. once the account shows as logged in. */
  function reset() {
    attempt++;
    show("form");
  }

  function dispose() {
    disposed = true;
    attempt++;
    stopPolling();
  }

  return { state, submit, renewDevice, cancel, reset, dispose };
}
