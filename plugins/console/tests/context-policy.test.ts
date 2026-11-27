import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { validateContextPolicy } from "../../../scripts/runtime-manager.mjs";
import { contextPolicy, readContextPolicy } from "../src/context-policy.js";

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function temp() {
  const root = mkdtempSync(join(tmpdir(), "yb-context-"));
  roots.push(root);
  return root;
}
function fixture() {
  const file = join(temp(), "context.json");
  const policy = contextPolicy({ magicContext: { triggerTokens: 120000 } });
  writeFileSync(file, JSON.stringify(policy));
  return { file, policy };
}

it("shares only explicit context fields, and both validators agree", () => {
  const input = {
    archive: { maxKB: 1024 },
    compact: { mode: "compartment", model: "owner:private" },
    magicContext: { enabled: true, triggerTokens: 120000, model: "owner:other" },
    secret: "hidden",
  };
  const policy = contextPolicy(input);
  expect(policy.session).toEqual({ archive: { maxKB: 1024 }, magicContext: { triggerTokens: 120000 } });
  expect(JSON.stringify(policy)).not.toMatch(/owner:|hidden/);
  expect(validateContextPolicy(policy)).toEqual(policy);
  expect(() => contextPolicy({ magicContext: { triggerTokens: NaN } })).toThrow();
  expect(() => validateContextPolicy({ ...policy, secret: "bad" })).toThrow();
  expect(() => validateContextPolicy({ ...policy, session: { ...policy.session, magicContext: { triggerTokens: 120000, model: "owner:key" } } })).toThrow();
});

it("refuses a policy file that carries a key Core no longer reads", () => {
  const h = fixture();
  const keys = [
    ["compact", { mode: "compartment" }],
    ["magicContext", { enabled: true, triggerTokens: 120000 }],
    ["magicContext", { model: "", triggerTokens: 120000 }],
    ["magicContext", { contextWindow: 147200, triggerTokens: 120000 }],
    ["ownHistoryVerbatim", 4],
  ] as const;
  for (const [key, value] of keys) {
    const old = { ...h.policy, session: { ...h.policy.session, [key]: value } };
    writeFileSync(h.file, JSON.stringify(old));
    expect(() => readContextPolicy(h.file)).toThrow("invalid_context_policy");
    expect(() => validateContextPolicy(old)).toThrow();
  }
});

it("rejects an invalid policy file", () => {
  const h = fixture();
  writeFileSync(h.file, "{}");
  expect(() => readContextPolicy(h.file)).toThrow();
  writeFileSync(h.file, '{"broken":true}');
  expect(() => readContextPolicy(h.file)).toThrow();
});

it("shares the Magic Context trigger only when set", () => {
  const unset = contextPolicy({});
  expect(unset.session.magicContext).toEqual({});
  const definition = JSON.parse(readFileSync(join(__dirname, "../src/shared/context-policy.json"), "utf8"));
  expect(Object.keys(definition)).toEqual(["archive", "magicContext"]);
  expect(Object.keys(definition.magicContext)).toEqual(["triggerTokens"]);
  const set = contextPolicy({ magicContext: { triggerTokens: 14000 } });
  expect(set.session.magicContext).toEqual({ triggerTokens: 14000 });
  expect(validateContextPolicy(set)).toEqual(set);
  for (const invalid of [7999, 14000.5, "14000"]) expect(() => contextPolicy({ magicContext: { triggerTokens: invalid } })).toThrow("invalid_context_policy");
});
