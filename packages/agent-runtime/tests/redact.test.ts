import { afterEach, expect, it } from "vitest";

import { redactSecrets } from "../src/redact.js";

const ENV = "YESIMBOT_TEST_API_KEY";
afterEach(() => {
  delete process.env[ENV];
});

it("removes provider keys, bearer credentials, key=value secrets and URL queries", () => {
  const text =
    "401 from https://user:pw@api.example.com/v1/models?key=AIzaSyA1234567890abcdef#x: Authorization: Bearer abc.def.ghi; api_key=xyz987 sk-ant-123456789 tvly-dev-abcdef ghp_abcdefghij";
  const result = redactSecrets(text);
  for (const secret of ["user:pw", "AIzaSyA1234567890abcdef", "abc.def.ghi", "xyz987", "sk-ant-123456789", "tvly-dev-abcdef", "ghp_abcdefghij", "#x"]) {
    expect(result).not.toContain(secret);
  }
  expect(result).toContain("https://api.example.com/v1/models");
});

it("removes the values of secret-looking environment variables, plain or URL-encoded", () => {
  process.env[ENV] = "p@ss word/123";
  expect(redactSecrets(`failed with p@ss word/123 and ${encodeURIComponent("p@ss word/123")}`)).toBe("failed with [redacted] and [redacted]");
});
