import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { NapCatLoginStep, NapCatQrCode, NapCatStatus } from "../src/shared/napcat";
import { createNapCatState } from "../web/src/state/napcat-state";
import { createQQPasswordLogin } from "../web/src/state/qq-password-login";

const code = (id: string): NapCatQrCode => ({ image: `data:image/png;base64,${id.toUpperCase()}AAAA`, id });
const loggedOut = (qrId: string): NapCatStatus => ({ available: true, loggedIn: false, online: false, qrId });
const disposers: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
});

/** A stand-in for adminRequest that answers each QQ endpoint from the current fixture values. */
function napcat(initial: NapCatStatus, qr: NapCatQrCode) {
  const fixture = { status: initial, qr, refreshed: code("fresh"), gate: undefined as Promise<void> | undefined };
  const request = vi.fn(async (path: string, _body?: object, _options?: { fresh?: boolean }) => {
    if (path === "napcat/status") {
      await fixture.gate;
      return fixture.status;
    }
    if (path === "napcat/qrcode") return fixture.qr;
    if (path === "napcat/qrcode/refresh") return fixture.refreshed;
    throw new Error(`unexpected ${path}`);
  });
  const model = createNapCatState(request as never);
  disposers.push(model.dispose);
  const reads = (path: string) => request.mock.calls.filter(([called]) => called === path);
  return { fixture, request, model, reads };
}

it("downloads a QR image only when NapCat reports a different code", async () => {
  const { fixture, request, model, reads } = napcat(loggedOut("a"), code("a"));
  await model.setVisible(true);
  // The first read may come from the browser cache; a fresh read follows at once.
  expect(request.mock.calls.map(([path, , options]) => [path, options?.fresh === true])).toEqual([
    ["napcat/status", false],
    ["napcat/qrcode", false],
  ]);
  expect(model.state.qrCode).toBe(code("a").image);
  await vi.advanceTimersByTimeAsync(0);
  expect(request.mock.calls.at(-1)).toEqual(["napcat/status", undefined, { fresh: true }]);
  await vi.advanceTimersByTimeAsync(4000);
  expect(reads("napcat/status").length).toBeGreaterThanOrEqual(4);
  expect(reads("napcat/qrcode")).toHaveLength(1);

  // NapCat replaced the expired code by itself: the page follows without any click.
  fixture.status = loggedOut("b");
  fixture.qr = code("b");
  await vi.advanceTimersByTimeAsync(2000);
  expect(reads("napcat/qrcode")).toHaveLength(2);
  expect(model.state.qrCode).toBe(code("b").image);
  expect(model.state.qrId).toBe("b");
  expect(model.state.notice).toContain("已更新");
});

it("runs a refresh clicked during a background poll instead of folding it into that poll", async () => {
  const { fixture, model, reads } = napcat(loggedOut("a"), code("a"));
  await model.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  let release!: () => void;
  fixture.gate = new Promise((resolve) => (release = resolve));
  await vi.advanceTimersByTimeAsync(2000);
  // A background poll is in flight and does not mark the page busy.
  expect(model.state.busy).toBe(false);
  const click = model.refresh(true);
  expect(model.state.busy).toBe(true);
  fixture.gate = undefined;
  release();
  await click;
  expect(reads("napcat/qrcode/refresh")).toHaveLength(1);
  expect(model.state.qrCode).toBe(code("fresh").image);
  expect(model.state.notice).toContain("已换成新的二维码");
  expect(model.state.busy).toBe(false);
});

it("remembers a code that a refresh could not replace as dead, until NapCat shows another", async () => {
  const { fixture, model } = napcat(loggedOut("a"), code("a"));
  await model.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  fixture.refreshed = { ...code("a"), message: "NapCat has not issued a new QR code yet." };
  await model.refresh(true);
  expect(model.state.deadQrId).toBe("a");
  expect(model.state.notice).toBe("");
  fixture.status = loggedOut("b");
  fixture.qr = code("b");
  await vi.advanceTimersByTimeAsync(2000);
  expect(model.state.qrId).toBe("b");
  expect(model.state.deadQrId).toBe("a");
});

it("keeps polling quickly while a confirmed login is still connecting", async () => {
  const { fixture, reads, model } = napcat({ available: true, loggedIn: true, connecting: true }, code("a"));
  await model.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  const before = reads("napcat/status").length;
  await vi.advanceTimersByTimeAsync(2000);
  expect(reads("napcat/status").length).toBe(before + 1);
  expect(model.state.qrCode).toBe("");
  fixture.status = { available: true, loggedIn: true, online: true, accountId: "123" };
  await vi.advanceTimersByTimeAsync(2000);
  const settled = reads("napcat/status").length;
  await vi.advanceTimersByTimeAsync(9000);
  expect(reads("napcat/status").length).toBe(settled);
  expect(reads("napcat/qrcode")).toHaveLength(0);
});

/** A password-login flow whose server answers come from `steps` in order; `solved: null` means the user closed the captcha. */
function passwordFlow(steps: (NapCatLoginStep | Error)[], solved: { ticket: string; randstr: string } | null = { ticket: "T", randstr: "R" }) {
  const request = vi.fn(async (path: string, _body?: object) => {
    if (path === "napcat/login/cancel") return {};
    const next = steps.shift();
    if (!next || next instanceof Error) throw next ?? new Error("no answer");
    return next;
  });
  const solve = vi.fn(async () => solved ?? undefined);
  const flow = createQQPasswordLogin(request as never, solve);
  disposers.push(flow.dispose);
  return { request, solve, flow };
}

it("walks password, captcha and new-device confirmation until QQ accepts the login", async () => {
  const image = "data:image/png;base64,DEVICE";
  const { request, solve, flow } = passwordFlow([
    { step: "captcha", captcha: { appId: "2081081773", sid: "S" } },
    { step: "device", image },
    { step: "device", image, scanned: true },
    new Error("请求失败，请稍后重试。"),
    { step: "submitted" },
  ]);
  await flow.submit("12345", "secret-pw");
  expect(request.mock.calls[0]).toEqual(["napcat/login/password", { uin: "12345", password: "secret-pw" }]);
  expect(solve).toHaveBeenCalledWith({ appId: "2081081773", sid: "S" });
  expect(request.mock.calls[1]).toEqual(["napcat/login/captcha", { ticket: "T", randstr: "R" }]);
  expect(flow.state).toMatchObject({ phase: "device", deviceImage: image, scanned: false });
  await vi.advanceTimersByTimeAsync(2500);
  expect(flow.state).toMatchObject({ phase: "device", scanned: true });
  expect(flow.state.notice).toContain("在手机上确认");
  // A dropped poll keeps the verification going.
  await vi.advanceTimersByTimeAsync(2500);
  expect(flow.state.phase).toBe("device");
  expect(flow.state.notice).toContain("重试");
  await vi.advanceTimersByTimeAsync(5000);
  expect(flow.state.phase).toBe("submitted");
  expect(request.mock.calls.slice(2).map(([path]) => path)).toEqual(["napcat/login/device", "napcat/login/device", "napcat/login/device"]);
  expect(JSON.stringify(flow.state)).not.toContain("secret-pw");
});

it("returns to the form when the captcha is closed and tells the server to forget the attempt", async () => {
  const { request, flow } = passwordFlow([{ step: "captcha", captcha: { appId: "1" } }], null);
  await flow.submit("12345", "pw");
  expect(flow.state.phase).toBe("form");
  expect(flow.state.notice).toContain("已取消安全验证");
  expect(request.mock.calls.map(([path]) => path)).toEqual(["napcat/login/password", "napcat/login/cancel"]);
});

it("explains refused, expired and failed device logins with fixed texts plus QQ's own reason", async () => {
  const { flow } = passwordFlow([
    { step: "failed", reason: "rejected", message: "你输入的帐号或密码不正确，请重新输入。" },
    { step: "failed", reason: "rejected" },
    { step: "failed", reason: "expired" },
    { step: "failed", reason: "device" },
  ]);
  const errors: string[] = [];
  for (let i = 0; i < 4; i++) {
    await flow.submit("12345", "pw");
    expect(flow.state.phase).toBe("form");
    errors.push(flow.state.error);
  }
  expect(errors[0]).toBe("QQ 未通过这次登录：你输入的帐号或密码不正确，请重新输入。");
  expect(errors[1]).toContain("检查 QQ 号和密码");
  expect(errors[2]).toContain("已过期");
  expect(errors[3]).toContain("新设备验证码");
});

it("drops a late answer once the user cancelled", async () => {
  let answer!: (step: NapCatLoginStep) => void;
  const request = vi.fn((path: string) => (path === "napcat/login/cancel" ? Promise.resolve({}) : new Promise((resolve) => (answer = resolve))));
  const flow = createQQPasswordLogin(request as never, vi.fn());
  disposers.push(flow.dispose);
  const submitted = flow.submit("12345", "pw");
  expect(flow.state.phase).toBe("submitting");
  await flow.cancel();
  answer({ step: "device", image: "data:image/png;base64,AAAA" });
  await submitted;
  expect(flow.state).toMatchObject({ phase: "form", deviceImage: "" });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(request.mock.calls.map(([path]) => path)).toEqual(["napcat/login/password", "napcat/login/cancel"]);
});
