import { createHash, createHmac } from "node:crypto";

import { afterEach, expect, it, vi } from "vitest";

import { controlLoginFingerprint } from "../src/relay-control-identity";

afterEach(() => vi.unstubAllEnvs());
it("trusts only a manager-signed login on a managed child, and otherwise uses the current login cookie", () => {
  const login = "a".repeat(64),
    cookie = "private-backend-cookie";
  const headers: Record<string, string> = {
    cookie,
    "x-yesimbot-control-login": login,
    "x-yesimbot-control-proof": createHmac("sha256", cookie).update(`desktop-login:${login}`).digest("hex"),
  };
  const http = { get: (name: string) => headers[name] ?? "" },
    fallback = createHash("sha256").update(cookie).digest("hex");
  vi.stubEnv("YESIMBOT_TENANT_ID", "");
  vi.stubEnv("YESIMBOT_MANAGED_CONTEXT", "");
  expect(controlLoginFingerprint(http)).toBe(fallback);
  vi.stubEnv("YESIMBOT_TENANT_ID", "11111111-1111-4111-8111-111111111111");
  expect(controlLoginFingerprint(http)).toBe(login);
  headers["x-yesimbot-control-proof"] = "0".repeat(64);
  expect(controlLoginFingerprint(http)).toBe(fallback);
});
