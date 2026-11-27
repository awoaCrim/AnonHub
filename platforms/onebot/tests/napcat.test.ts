import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { NapCatGateway, normalizeQrCode } from "../src/napcat.js";

describe("NapCat gateway", () => {
  it("rejects non-loopback and decorated targets", () => {
    for (const endpoint of ["http://evil.example", "http://127.0.0.1/redirect", "http://secret@localhost", "https://localhost", "http://localhost/?target=x"])
      expect(() => new NapCatGateway({ endpoint, webuiConfigFile: "unused" })).toThrow();
  });
  it("authenticates privately and calls only fixed POST APIs without forwarding upstream messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "napcat-gateway-"));
    const path = join(dir, "webui.json");
    try {
      await writeFile(path, JSON.stringify({ token: "server-only-secret" }));
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { Credential: "private-token" } }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { isLogin: true, isOffline: false, qrcodeurl: "", loginError: "" } }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { uin: "123", nick: "Owner", uid: "u_owner", online: true } }) })
        .mockResolvedValueOnce({ ok: false });
      const gateway = new NapCatGateway({ endpoint: "http://127.0.0.1:6099", webuiConfigFile: path }, fetcher);
      expect(await gateway.status()).toMatchObject({
        available: true,
        loggedIn: true,
        accountId: "123",
        nickname: "Owner",
        uid: "u_owner",
        online: true,
        avatarUrl: "https://q1.qlogo.cn/g?b=qq&nk=123&s=140",
      });
      expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
        "http://127.0.0.1:6099/api/auth/login",
        "http://127.0.0.1:6099/api/QQLogin/CheckLoginStatus",
        "http://127.0.0.1:6099/api/QQLogin/GetQQLoginInfo",
      ]);
      expect(fetcher.mock.calls[0][1].body).not.toContain("server-only-secret");
      expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "POST", purpose: "internal", headers: { Authorization: "Bearer private-token" } });
      expect(JSON.stringify(await gateway.status())).not.toContain("private-token");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("normalizes QR images/URLs and rejects executable or credential-bearing URLs", () => {
    expect(normalizeQrCode({ qrcode: "data:image/png;base64,AAAA" })).toEqual({ image: "data:image/png;base64,AAAA" });
    expect(normalizeQrCode({ qrcode: "https://qq.example/qr" })).toEqual({ url: "https://qq.example/qr", qrCode: "https://qq.example/qr" });
    expect(normalizeQrCode("javascript:alert(1)").image).toBeUndefined();
    expect(normalizeQrCode("https://password@qq.example").url).toBeUndefined();
  });
});

it("encodes QR URLs locally without fetching their origin and bounds their size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "napcat-qr-"));
  const path = join(dir, "webui.json");
  try {
    await writeFile(path, JSON.stringify({ token: "private-secret" }));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { Credential: "private-token" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { qrcodeurl: "https://qq.example/login?code=qr" } }) });
    const gateway = new NapCatGateway({ endpoint: "http://127.0.0.1:6099", webuiConfigFile: path }, fetcher);
    const result = await gateway.qrcode();
    expect(result.image).toMatch(/^data:image\/png;base64,/);
    expect(result.url).toBeUndefined();
    expect(fetcher.mock.calls).toHaveLength(2);
    expect(fetcher.mock.calls.every((call) => call[0].startsWith("http://127.0.0.1:6099/api/"))).toBe(true);
    expect(normalizeQrCode({ qrcode: "https://qq.example/" + "x".repeat(2048) }).url).toBeUndefined();
    expect(normalizeQrCode({ qrcodeurl: "https://qq.example/qr" }).url).toBe("https://qq.example/qr");
    expect(normalizeQrCode({ qrcode: "https://[invalid" }).url).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("skips account lookup when logged out and never forwards upstream login errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "napcat-status-"));
  const path = join(dir, "webui.json");
  try {
    await writeFile(path, JSON.stringify({ token: "private-secret" }));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { Credential: "private-token" } }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, data: { isLogin: false, isOffline: false, loginError: "private-secret private-token", qrcodeurl: "private-qr" } }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { qrcode: "https://qq.example/qr" } }) });
    const result = await new NapCatGateway({ endpoint: "http://127.0.0.1:6099", webuiConfigFile: path }, fetcher).status();
    expect(result).toEqual({
      available: true,
      loggedIn: false,
      online: false,
      qrId: expect.stringMatching(/^[0-9a-f]{16}$/),
      qrAge: expect.any(Number),
      loginProblem: "failed",
    });
    expect(fetcher.mock.calls.map(([url]) => url.split("/api/")[1])).toEqual(["auth/login", "QQLogin/CheckLoginStatus", "QQLogin/GetQQLoginQrcode"]);
    expect(JSON.stringify(result)).not.toMatch(/private-secret|private-token|qq\.example/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("preserves offline login state on profile failures and rejects upstream avatar URLs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "napcat-profile-"));
  const path = join(dir, "webui.json");
  try {
    await writeFile(path, JSON.stringify({ token: "private-secret" }));
    const response = (data: unknown) => ({ ok: true, json: async () => ({ code: 0, data }) });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ Credential: "private-token" }))
      .mockResolvedValueOnce(response({ isLogin: false, isOffline: true, loginError: "private-secret" }))
      .mockResolvedValueOnce(response({ uin: "12345&target=evil", uid: "u_owner", nick: "Owner", online: true, avatarUrl: "https://evil.example/secret" }))
      .mockResolvedValueOnce(response({ isLogin: true, isOffline: true }))
      .mockRejectedValueOnce(new Error("private-secret private-token"));
    const gateway = new NapCatGateway({ endpoint: "http://127.0.0.1:6099", webuiConfigFile: path }, fetcher);
    const profile = await gateway.status();
    expect(profile).toMatchObject({ available: true, loggedIn: true, online: false, uid: "u_owner", nickname: "Owner" });
    expect(profile.avatarUrl).toBeUndefined();
    const failed = await gateway.status();
    expect(failed).toMatchObject({ available: true, loggedIn: true, online: false });
    expect(failed.message).toContain("offline");
    expect(JSON.stringify([profile, failed])).not.toMatch(/private-secret|private-token|evil.example/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps a healthy login available when only account lookup fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "napcat-profile-failure-"));
  const path = join(dir, "webui.json");
  try {
    await writeFile(path, JSON.stringify({ token: "private-secret" }));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { Credential: "private-token" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { isLogin: true, isOffline: false } }) })
      .mockResolvedValueOnce({ ok: false });
    const result = await new NapCatGateway({ endpoint: "http://127.0.0.1:6099", webuiConfigFile: path }, fetcher).status();
    expect(result).toMatchObject({ available: true, loggedIn: true });
    expect(result.online).toBeUndefined();
    expect(result.message).toContain("temporarily unavailable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("coalesces logout, clears quick login and writes a private marker before restarting only the QQ worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "napcat-logout-"));
  const path = join(dir, "webui.json");
  const marker = join(dir, "yesimbot-logged-out");
  try {
    await writeFile(path, JSON.stringify({ token: "server-only-secret" }));
    const response = (data: unknown = {}) => ({ ok: true, json: async () => ({ code: 0, data }) });
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("auth/login")) return response({ Credential: "private-token" });
      if (url.endsWith("RestartNapCat")) {
        expect(await readFile(marker, "utf8")).toBe("{}\n");
        expect((await stat(marker)).mode & 0o777).toBe(0o600);
      }
      return response({ secret: "not-forwarded" });
    });
    const gateway = new NapCatGateway({ endpoint: "http://127.0.0.1:6099", webuiConfigFile: path }, fetcher as never);
    const first = gateway.logout();
    expect(gateway.logout()).toBe(first);
    expect(await first).toMatchObject({ accepted: true });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:6099/api/auth/login",
      "http://127.0.0.1:6099/api/QQLogin/SetQuickLoginQQ",
      "http://127.0.0.1:6099/api/QQLogin/RestartNapCat",
    ]);
    expect(fetcher.mock.calls[1][1]).toMatchObject({
      method: "POST",
      purpose: "internal",
      body: '{"uin":""}',
      headers: { Authorization: "Bearer private-token" },
    });
    expect(fetcher.mock.calls[2][1]).toMatchObject({ body: "{}" });
    expect(JSON.stringify(await gateway.logout())).not.toMatch(/private-token|server-only-secret|not-forwarded/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])("retains logout intent on restart failure (existing=%s, rejected=%s)", async (existing, rejected) => {
  const dir = await mkdtemp(join(tmpdir(), "napcat-logout-failed-"));
  const path = join(dir, "webui.json");
  const marker = join(dir, "yesimbot-logged-out");
  try {
    await writeFile(path, JSON.stringify({ token: "server-only-secret" }));
    if (existing) await writeFile(marker, "{}\n", { mode: 0o600 });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { Credential: "private-token" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: {} }) });
    if (rejected) fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ code: 1, message: "server-only-secret private-token" }) });
    else fetcher.mockRejectedValueOnce(new Error("server-only-secret private-token"));
    const gateway = new NapCatGateway({ endpoint: "http://127.0.0.1:6099", webuiConfigFile: path }, fetcher);
    await expect(gateway.logout()).rejects.toThrow("Cannot request QQ logout.");
    expect(await readFile(marker, "utf8")).toBe("{}\n");
    expect(fetcher.mock.calls).toHaveLength(3);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("RestartNapCat"))).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not create logout intent or call upstream when server credentials are missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "napcat-token-missing-"));
  try {
    const fetcher = vi.fn();
    const gateway = new NapCatGateway({ endpoint: "http://127.0.0.1:6099", webuiConfigFile: join(dir, "missing.json") }, fetcher);
    await expect(gateway.logout()).rejects.toThrow("Cannot request QQ logout.");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(stat(join(dir, "yesimbot-logged-out"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not restart or create a marker when clearing quick login fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "napcat-clear-failed-"));
  const path = join(dir, "webui.json");
  try {
    await writeFile(path, JSON.stringify({ token: "secret" }));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { Credential: "private-token" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 1, message: "secret" }) });
    await expect(new NapCatGateway({ endpoint: "http://127.0.0.1:6099", webuiConfigFile: path }, fetcher).logout()).rejects.toThrow(
      "Cannot request QQ logout.",
    );
    expect(fetcher.mock.calls).toHaveLength(2);
    await expect(stat(join(dir, "yesimbot-logged-out"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** NapCat's refusal: HTTP 200 with `code: -1`, exactly as the pinned WebUI answers. */
class Refusal {
  constructor(readonly message: string) {}
}

/** A NapCat WebUI double on a manual clock; handlers answer QQLogin paths and every call keeps its JSON body. */
async function fakeNapCat(handlers: Record<string, (body: Record<string, string>) => unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "napcat-fake-"));
  const path = join(dir, "webui.json");
  await writeFile(path, JSON.stringify({ token: "server-only-secret" }));
  const calls: { path: string; body: Record<string, string>; token?: string }[] = [];
  let logins = 0;
  let now = 0;
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const name = url.split("/api/")[1];
    calls.push({ path: name, body: JSON.parse(String(init.body)), token: (init.headers as Record<string, string>).Authorization });
    if (name === "auth/login") return { ok: true, json: async () => ({ code: 0, data: { Credential: `token-${++logins}` } }) };
    const result = handlers[name] ? handlers[name](calls.at(-1)!.body) : new Refusal("unexpected call");
    return { ok: true, json: async () => (result instanceof Refusal ? { code: -1, message: result.message } : { code: 0, data: result, message: "success" }) };
  });
  const clock = {
    now: () => now,
    wait: async (ms: number) => {
      now += ms;
    },
  };
  return {
    gateway: new NapCatGateway({ endpoint: "http://127.0.0.1:6099", webuiConfigFile: path }, fetcher as never, clock),
    calls,
    advance: (ms: number) => {
      now += ms;
    },
    /** QQLogin calls only, without the WebUI authentication. */
    paths: () => calls.map((call) => call.path).filter((name) => name !== "auth/login"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe("QQ login QR code", () => {
  it("waits for NapCat to issue a new code after a refresh instead of returning the old one", async () => {
    // NapCat's RefreshQRcode only asks QQ for a code; GetQQLoginQrcode keeps answering the old one for a moment.
    const codes = ["https://qq.example/old", "https://qq.example/old", "https://qq.example/old", "https://qq.example/new"];
    const napcat = await fakeNapCat({
      "QQLogin/GetQQLoginQrcode": () => ({ qrcode: codes.shift() ?? "https://qq.example/new" }),
      "QQLogin/RefreshQRcode": () => null,
    });
    try {
      const before = await napcat.gateway.qrcode();
      const first = napcat.gateway.refreshQr();
      expect(napcat.gateway.refreshQr()).toBe(first);
      const after = await first;
      expect(before.id).toMatch(/^[0-9a-f]{16}$/);
      expect(after.id).toMatch(/^[0-9a-f]{16}$/);
      expect(after.id).not.toBe(before.id);
      expect(after.image).toMatch(/^data:image\/png;base64,/);
      expect(after.image).not.toBe(before.image);
      expect(after.message).toBeUndefined();
      expect(napcat.paths().filter((name) => name === "QQLogin/RefreshQRcode")).toHaveLength(1);
    } finally {
      await napcat.cleanup();
    }
  });

  it("returns the current code with a notice when NapCat has not replaced it in time", async () => {
    const napcat = await fakeNapCat({ "QQLogin/GetQQLoginQrcode": () => ({ qrcode: "https://qq.example/same" }), "QQLogin/RefreshQRcode": () => null });
    try {
      const result = await napcat.gateway.refreshQr();
      expect(result.image).toMatch(/^data:image\/png;base64,/);
      expect(result.message).toBeTruthy();
      expect(napcat.paths().filter((name) => name === "QQLogin/GetQQLoginQrcode").length).toBeGreaterThan(10);
    } finally {
      await napcat.cleanup();
    }
  });

  it("names the current code in the status, so a page can tell NapCat replaced an expired code", async () => {
    let code = "https://qq.example/first";
    const napcat = await fakeNapCat({
      // NapCat keeps "二维码已过期" after it already issued the replacement code; that is not a problem to report.
      "QQLogin/CheckLoginStatus": () => ({ isLogin: false, isOffline: false, qrcodeurl: code, loginError: "二维码已过期，请刷新" }),
      "QQLogin/GetQQLoginQrcode": () => ({ qrcode: code }),
    });
    try {
      const first = await napcat.gateway.status();
      expect(first).toEqual({ available: true, loggedIn: false, online: false, qrId: (await napcat.gateway.qrcode()).id, qrAge: 0 });
      napcat.advance(60_000);
      // The same code keeps aging, so a page can tell how long it has been up.
      expect((await napcat.gateway.status()).qrAge).toBe(60);
      code = "https://qq.example/second";
      const second = await napcat.gateway.status();
      expect(second.qrId).toBe((await napcat.gateway.qrcode()).id);
      expect(second.qrId).not.toBe(first.qrId);
      expect(second.qrAge).toBe(0);
    } finally {
      await napcat.cleanup();
    }
  });

  it("reports a scanned and confirmed login as connecting before NapCat says the account is online", async () => {
    const napcat = await fakeNapCat({
      "QQLogin/CheckLoginStatus": () => ({ isLogin: false, isOffline: false, qrcodeurl: "https://qq.example/used", loginError: "" }),
      "QQLogin/GetQQLoginQrcode": () => new Refusal("QQ Is Logined"),
      "QQLogin/GetQQLoginInfo": () => ({}),
    });
    try {
      expect(await napcat.gateway.status()).toEqual({ available: true, loggedIn: true, connecting: true });
      expect(await napcat.gateway.qrcode()).toEqual({ message: "QQ is already logged in." });
    } finally {
      await napcat.cleanup();
    }
  });

  it("makes a sign-in it watched NapCat's quick login, so a restart signs in again without a code", async () => {
    let state: "out" | "in" = "out";
    const napcat = await fakeNapCat({
      "QQLogin/CheckLoginStatus": () => (state === "in" ? { isLogin: true, isOffline: false } : { isLogin: false, isOffline: false, loginError: "" }),
      "QQLogin/GetQQLoginQrcode": () => ({ qrcode: "https://txz.qq.com/p?k=code-1" }),
      "QQLogin/GetQQLoginInfo": () => ({ uin: "10001", nick: "Athena", online: true }),
      "QQLogin/SetQuickLoginQQ": () => null,
      "QQLogin/RestartNapCat": () => null,
    });
    const quick = () => napcat.calls.filter((call) => call.path === "QQLogin/SetQuickLoginQQ").map((call) => call.body.uin);
    try {
      expect(await napcat.gateway.status()).toMatchObject({ loggedIn: false });
      state = "in";
      expect(await napcat.gateway.status()).toMatchObject({ loggedIn: true, accountId: "10001" });
      await napcat.gateway.status();
      expect(quick()).toEqual(["10001"]);
      // Logging out clears it; QQ still reads as signed in until NapCat restarts, which must not set it back.
      await napcat.gateway.logout();
      await napcat.gateway.status();
      expect(quick()).toEqual(["10001", ""]);
      state = "out";
      await napcat.gateway.status();
      state = "in";
      await napcat.gateway.status();
      expect(quick()).toEqual(["10001", "", "10001"]);
    } finally {
      await napcat.cleanup();
    }
  });

  it("leaves the quick login alone for an account that was already signed in", async () => {
    const napcat = await fakeNapCat({
      "QQLogin/CheckLoginStatus": () => ({ isLogin: true, isOffline: false }),
      "QQLogin/GetQQLoginInfo": () => ({ uin: "10001", online: true }),
    });
    try {
      expect(await napcat.gateway.status()).toMatchObject({ loggedIn: true, accountId: "10001" });
      expect(napcat.paths()).toEqual(["QQLogin/CheckLoginStatus", "QQLogin/GetQQLoginInfo"]);
    } finally {
      await napcat.cleanup();
    }
  });

  it("reports a forced logout and other login failures only as categories", async () => {
    let loginError = "[KickedOffLine] [下线通知] private-secret";
    const napcat = await fakeNapCat({
      "QQLogin/CheckLoginStatus": () => ({ isLogin: false, isOffline: false, qrcodeurl: "", loginError }),
      "QQLogin/GetQQLoginQrcode": () => new Refusal("QRCode Get Error"),
    });
    try {
      const kicked = await napcat.gateway.status();
      expect(kicked).toEqual({ available: true, loggedIn: false, online: false, loginProblem: "kicked" });
      loginError = '登录失败: [0,{"message":"private-secret","serverErrorCode":1}]';
      const failed = await napcat.gateway.status();
      expect(failed.loginProblem).toBe("failed");
      expect(JSON.stringify([kicked, failed])).not.toContain("private-secret");
      expect(await napcat.gateway.qrcode()).toEqual({ message: "QR code is not ready. Refresh it after NapCat finishes starting." });
    } finally {
      await napcat.cleanup();
    }
  });

  it("signs in again once when NapCat's hour-long WebUI credential expires", async () => {
    let refusals = 1;
    const napcat = await fakeNapCat({
      "QQLogin/CheckLoginStatus": () => (refusals-- > 0 ? new Refusal("Unauthorized") : { isLogin: true, isOffline: false }),
      "QQLogin/GetQQLoginInfo": () => ({ uin: "123", nick: "Owner", online: true }),
    });
    try {
      expect(await napcat.gateway.status()).toMatchObject({ available: true, loggedIn: true, accountId: "123" });
      expect(napcat.calls.map((call) => call.path)).toEqual([
        "auth/login",
        "QQLogin/CheckLoginStatus",
        "auth/login",
        "QQLogin/CheckLoginStatus",
        "QQLogin/GetQQLoginInfo",
      ]);
      expect(napcat.calls[3].token).toBe("Bearer token-2");
      refusals = 5;
      expect(await napcat.gateway.status()).toMatchObject({ available: false, loggedIn: false });
      // One fresh sign-in per refused call, never a loop.
      expect(napcat.calls.filter((call) => call.path === "auth/login")).toHaveLength(3);
    } finally {
      await napcat.cleanup();
    }
  });
});

describe("QQ password login", () => {
  const md5 = (value: string) => createHash("md5").update(value, "utf8").digest("hex");

  it("sends only the password hash and reports an accepted login as submitted", async () => {
    const napcat = await fakeNapCat({ "QQLogin/PasswordLogin": () => null });
    try {
      expect(await napcat.gateway.passwordLogin("12345", "correct horse")).toEqual({ step: "submitted" });
      expect(napcat.calls.at(-1)).toMatchObject({ path: "QQLogin/PasswordLogin", body: { uin: "12345", passwordMd5: md5("correct horse") } });
      expect(JSON.stringify(napcat.calls)).not.toContain("correct horse");
      expect(await napcat.gateway.captchaLogin("ticket", "rand")).toEqual({ step: "failed", reason: "expired" });
    } finally {
      await napcat.cleanup();
    }
  });

  it("walks the captcha and new-device steps with the pending login kept on the server", async () => {
    let device = 3;
    const napcat = await fakeNapCat({
      "QQLogin/PasswordLogin": () => ({ needCaptcha: true, proofWaterUrl: "https://ti.qq.com/captcha?aid=2081081773&sid=S1&uin=12345&login_appid=716027609" }),
      "QQLogin/CaptchaLogin": () => ({ needNewDevice: true, jumpUrl: "https://accounts.qq.com/safe?sig=a&uin-token=b", newDevicePullQrCodeSig: "PULL" }),
      "QQLogin/GetNewDeviceQRCode": () => ({ str_url: "https://ti.qq.com/device?code=1", bytes_token: "TOKEN" }),
      "QQLogin/PollNewDeviceQR": () => (device === 3 ? { uint32_guarantee_status: device-- } : { uint32_guarantee_status: 1, str_nt_succ_token: "NT" }),
      "QQLogin/NewDeviceLogin": () => null,
    });
    try {
      expect(await napcat.gateway.passwordLogin("12345", "pw")).toEqual({
        step: "captcha",
        captcha: { appId: "2081081773", sid: "S1", uin: "12345", loginAppId: "716027609" },
      });
      const step = await napcat.gateway.captchaLogin("TICKET", "RAND");
      expect(step).toEqual({ step: "device", image: expect.stringMatching(/^data:image\/png;base64,/) });
      expect(napcat.calls.find((call) => call.path === "QQLogin/CaptchaLogin")?.body).toEqual({
        uin: "12345",
        passwordMd5: md5("pw"),
        ticket: "TICKET",
        randstr: "RAND",
        sid: "S1",
      });
      expect(await napcat.gateway.deviceLogin()).toMatchObject({ step: "device", scanned: true });
      expect(napcat.calls.at(-1)?.body).toEqual({ uin: "12345", bytesToken: "TOKEN" });
      expect(await napcat.gateway.deviceLogin()).toEqual({ step: "submitted" });
      expect(napcat.calls.at(-1)).toMatchObject({
        path: "QQLogin/NewDeviceLogin",
        body: { uin: "12345", passwordMd5: md5("pw"), newDevicePullQrCodeSig: "NT" },
      });
      expect(await napcat.gateway.deviceLogin()).toEqual({ step: "failed", reason: "expired" });
      // The device code is encoded locally; its link is never handed to the browser.
      expect(JSON.stringify(step)).not.toContain("ti.qq.com");
    } finally {
      await napcat.cleanup();
    }
  });

  it("forwards only short Chinese QQ explanations of a refused login", async () => {
    const answers = ["你输入的帐号或密码不正确，请重新输入。", "密码错误 private-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ", "uin is empty", "QQ Is Logined"];
    const napcat = await fakeNapCat({ "QQLogin/PasswordLogin": () => new Refusal(answers.shift()!) });
    try {
      expect(await napcat.gateway.passwordLogin("12345", "pw")).toEqual({
        step: "failed",
        reason: "rejected",
        message: "你输入的帐号或密码不正确，请重新输入。",
      });
      expect(await napcat.gateway.passwordLogin("12345", "pw")).toEqual({ step: "failed", reason: "rejected" });
      expect(await napcat.gateway.passwordLogin("12345", "pw")).toEqual({ step: "failed", reason: "rejected" });
      expect(await napcat.gateway.passwordLogin("12345", "pw")).toEqual({ step: "submitted" });
    } finally {
      await napcat.cleanup();
    }
  });

  it("forgets a pending verification after ten minutes or on cancel", async () => {
    const napcat = await fakeNapCat({ "QQLogin/PasswordLogin": () => ({ needCaptcha: true, proofWaterUrl: "https://ti.qq.com/captcha?sid=S" }) });
    try {
      expect(await napcat.gateway.passwordLogin("12345", "pw")).toMatchObject({ step: "captcha", captcha: { appId: "2081081773", sid: "S" } });
      napcat.advance(10 * 60_000);
      expect(await napcat.gateway.captchaLogin("T", "R")).toEqual({ step: "failed", reason: "expired" });
      await napcat.gateway.passwordLogin("12345", "pw");
      await napcat.gateway.cancelLogin();
      expect(await napcat.gateway.captchaLogin("T", "R")).toEqual({ step: "failed", reason: "expired" });
      expect(napcat.paths()).not.toContain("QQLogin/CaptchaLogin");
    } finally {
      await napcat.cleanup();
    }
  });
});
