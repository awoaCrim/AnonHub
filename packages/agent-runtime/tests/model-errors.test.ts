import { APICallError } from "ai";
import { describe, expect, it } from "vitest";

import { formatErrorCause } from "../src/errors.js";
import { classifyModelError, markModelError, modelFailureInfo } from "../src/model-errors.js";

describe("safe model failure categories", () => {
  it.each([
    [401, {}, "authentication"],
    [403, {}, "permission"],
    [402, {}, "quota"],
    [429, { error: { code: "insufficient_quota", message: "secret upstream response" } }, "quota"],
    [400, { error: { code: "context_length_exceeded" } }, "context_limit"],
    [400, { error: { type: "invalid_request_error", message: "prompt is too long: secret prompt" } }, "context_limit"],
    [429, {}, "rate_limit"],
    [503, {}, "unavailable"],
    [408, {}, "timeout"],
    [400, {}, "invalid_request"],
  ])("classifies %s privately as %s", (statusCode, data, expected) => {
    const error = new APICallError({ message: "secret request", url: "https://secret.invalid", requestBodyValues: {}, statusCode: statusCode as number, data });
    expect(classifyModelError(error).kind).toBe(expected);
    expect(formatErrorCause(error)).toContain(`[${expected}:`);
    expect(formatErrorCause(error)).not.toContain("secret");
  });
  it("follows the final SDK retry cause and preserves ordinary tool errors", () => {
    const original = Object.assign(new Error("secret socket details"), { code: "ETIMEDOUT" });
    const tagged = markModelError(original);
    expect(tagged).toBe(original);
    const retry = Object.assign(new Error("secret retry body"), { errors: [original], lastError: original });
    expect(modelFailureInfo(retry)).toEqual({ kind: "timeout" });
    expect(formatErrorCause(retry)).not.toContain("secret");
    expect(formatErrorCause(new Error("ordinary tool failure"))).toBe("Error: ordinary tool failure");
    expect(formatErrorCause(markModelError("secret primitive error"))).not.toContain("secret");
    expect(classifyModelError(Object.assign(new Error("image unsupported"), { name: "AI_UnsupportedFunctionalityError" })).kind).toBe("invalid_request");
  });
});
