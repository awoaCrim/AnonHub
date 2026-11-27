import { afterEach, describe, expect, it, vi } from "vitest";

import { redact, registerSecret, safeURL } from "../src/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("redact", () => {
  it("removes key prefixes, auth schemes, key=value secrets and URL credentials and queries", () => {
    const text = [
      "sk-abcdefghijkl ghp_abcdefghijkl github_pat_abcdefghij AIzaSyABCDEFGH xoxb-1234567890 tvly-abcdefghij",
      "Authorization: Bearer eyJhbGciOi.payload",
      'password=hunter22 "api_key": "abc123xyz" token: \'quoted-token\'',
      "https://user:pass@example.com/path?token=abc#frag",
    ].join("\n");
    const result = redact(text);
    for (const secret of ["abcdefghijkl", "eyJhbGciOi", "hunter22", "abc123xyz", "quoted-token", "user:pass", "token=abc", "#frag"])
      expect(result).not.toContain(secret);
    expect(result).toContain("Bearer [redacted]");
    expect(result).toContain("https://example.com/path");
  });

  it("removes registered secrets and secret-named environment values, also JSON-escaped and URI-encoded", () => {
    registerSecret('conf"ig/secret value');
    vi.stubEnv("SOME_API_TOKEN", "env token/value");
    const result = redact(['conf\\"ig/secret value', "conf%22ig%2Fsecret%20value", "env token/value", "env%20token%2Fvalue"].join(" | "));
    expect(result).toBe("[redacted] | [redacted] | [redacted] | [redacted]");
  });

  it("ignores short secrets and leaves ordinary text alone", () => {
    registerSecret("abc");
    expect(redact("abc is fine, so is sk-a")).toBe("abc is fine, so is sk-a");
  });

  it("safeURL drops credentials, query and fragment", () => {
    expect(safeURL("https://a:b@host.example:8443/x/y?q=1#h")).toBe("https://host.example:8443/x/y");
    expect(safeURL("not a url")).toBe("");
  });
});
