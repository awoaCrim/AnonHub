import { describe, expect, it } from "vitest";

import { AppError, defineErrors, errorEntry, errorFields, registeredErrorCodes, toChatText, toHttp, toToolResult } from "../src/index.js";

const codes = defineErrors({
  test_card_changed: { model: "角色卡已被修改，请重新读取。", user: "角色卡已被修改。", status: 409 },
  test_upstream_busy: { model: "上游服务繁忙。", user: "上游服务繁忙，请稍后再试。", status: 503, retryable: true },
});

describe("error catalog", () => {
  it("registers each code once (the same row again is fine), snake_case with a domain prefix, Chinese texts and a 4xx/5xx status", () => {
    expect(codes.test_card_changed).toBe("test_card_changed");
    expect(() => defineErrors({ test_card_changed: { model: "重复", user: "重复", status: 409 } })).toThrow(/twice/);
    // The same row again (a module loaded twice) is accepted; it stays one entry.
    expect(defineErrors({ test_card_changed: { model: "角色卡已被修改，请重新读取。", user: "角色卡已被修改。", status: 409 } })).toEqual({
      test_card_changed: "test_card_changed",
    });
    expect(() => defineErrors({ test_upstream_busy: { model: "上游服务繁忙。", user: "上游服务繁忙，请稍后再试。", status: 503 } })).toThrow(/twice/);
    expect(() => defineErrors({ changed: { model: "无前缀", user: "无前缀", status: 409 } })).toThrow(/snake_case/);
    expect(() => defineErrors({ test_English: { model: "大写", user: "大写", status: 409 } })).toThrow(/snake_case/);
    expect(() => defineErrors({ test_english_text: { model: "Card changed", user: "卡片", status: 409 } })).toThrow(/Chinese/);
    expect(() => defineErrors({ test_bad_status: { model: "状态", user: "状态", status: 200 } })).toThrow(/status/);
    expect(new Set(registeredErrorCodes()).size).toBe(registeredErrorCodes().length);
    for (const code of registeredErrorCodes()) expect(code).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/);
  });

  it("takes status and retryable from the catalog unless the error says otherwise", () => {
    expect(new AppError("test_upstream_busy")).toMatchObject({ status: 503, retryable: true, effect: "unknown" });
    expect(new AppError("test_upstream_busy", { retryable: false, status: 502, effect: "none" })).toMatchObject({
      status: 502,
      retryable: false,
      effect: "none",
    });
    expect(errorEntry("test_card_changed")?.status).toBe(409);
  });
});

describe("error exits", () => {
  const leaky = new AppError("test_upstream_busy", {
    effect: "none",
    detail: "upstream said key=sk-detailsecret123456",
    cause: new Error("POST https://api.example/v1?key=AIzaSyLeakedKey123456 failed: Bearer abcdef123456"),
  });

  it("gives the model the catalog sentence, the code, retryable and effect, never the error's own text", () => {
    expect(toToolResult(leaky)).toEqual({ ok: false, error: { code: "test_upstream_busy", message: "上游服务繁忙。", retryable: true }, effect: "none" });
    expect(toToolResult(new Error("sk-rawsecret123456"))).toEqual({
      ok: false,
      error: { code: "internal_error", message: "内部错误，操作没有完成。", retryable: false },
      effect: "unknown",
    });
    expect(toToolResult(new AppError("test_not_registered", { effect: "done" }))).toMatchObject({ error: { code: "internal_error" }, effect: "done" });
    expect(toToolResult(new DOMException("stop", "AbortError"))).toMatchObject({ error: { code: "request_aborted" } });
  });

  it("gives the console a status and a registered code only", () => {
    expect(toHttp(leaky)).toEqual({ status: 503, body: { code: "test_upstream_busy" } });
    expect(toHttp(new Error("boom"))).toEqual({ status: 500, body: { code: "internal_error" } });
  });

  it("gives a chat the fixed sentence, the code and a well-formed diagnostic ID", () => {
    expect(toChatText(leaky, "abc-123")).toBe("上游服务繁忙，请稍后再试。 [test_upstream_busy] 诊断编号：abc-123");
    expect(toChatText(new Error("x"), "bad id with spaces")).toBe("内部错误，操作没有完成。 [internal_error]");
  });

  it("logs name, code, redacted detail and cause chain", () => {
    const fields = errorFields(leaky);
    expect(fields).toMatchObject({ name: "AppError", message: "test_upstream_busy" });
    const text = JSON.stringify(fields);
    expect(text).not.toContain("sk-detailsecret123456");
    expect(text).not.toContain("AIzaSyLeakedKey123456");
    expect(text).not.toContain("abcdef123456");
    expect(fields.causes).toHaveLength(1);
    expect(fields.causes![0]).toContain("https://api.example/v1");
  });

  it("stops at five causes and at a cycle", () => {
    let error: Error = new Error("root");
    for (let index = 0; index < 8; index++) error = new Error(`level ${index}`, { cause: error });
    expect(errorFields(error).causes).toHaveLength(5);
    const cyclic = new Error("a");
    (cyclic as { cause?: unknown }).cause = cyclic;
    expect(errorFields(cyclic).causes).toBeUndefined();
    expect(errorFields("plain text")).toEqual({ name: "string", message: "plain text" });
  });
});
