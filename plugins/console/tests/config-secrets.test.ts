import { configForm } from "@yesimbot/foundation";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { formNode } from "../src/config/form.js";
import { redactSecrets, restoreSecrets } from "../src/config/secrets.js";
import type { PluginSchemaNode } from "../src/shared/plugin-config.js";

const secret = { secret: true } as const;
const form = (schema: z.ZodType): PluginSchemaNode => formNode(configForm(schema));

describe("plugin config secret traversal", () => {
  it("covers every nested union/intersection branch of a zod form", () => {
    const expanded = form(
      z.object({
        rows: z.array(
          z.intersection(
            z.object({ kind: z.string() }),
            z.union([z.object({ plain: z.string() }), z.object({ tokens: z.record(z.string(), z.string().meta(secret)) })]),
          ),
        ),
      }),
    );
    const value = { rows: [{ kind: "example", tokens: { a: "private", b: "other" }, opaque: 7 }] };
    const redacted = redactSecrets(value, expanded);
    expect(JSON.stringify(redacted)).not.toMatch(/private|other/);
    expect(redacted).toEqual({
      rows: [
        {
          kind: "example",
          tokens: { a: { $secret: true, sourcePath: ["rows", "0", "tokens", "a"] }, b: { $secret: true, sourcePath: ["rows", "0", "tokens", "b"] } },
          opaque: 7,
        },
      ],
    });
    expect(restoreSecrets(redacted, value, expanded)).toEqual(value);
    expect(value.rows[0].tokens.a).toBe("private");
  });
  it("protects nested dynamic secrets", () => {
    const dynamic: PluginSchemaNode = { type: "dynamic", name: "registry.private" };
    const dynamics = { "registry.private": form(z.object({ password: z.string().meta(secret) })) };
    const value = { password: "keep-me" };
    const redacted = redactSecrets(value, dynamic, dynamics);
    expect(redacted).toEqual({ password: { $secret: true, sourcePath: ["password"] } });
    expect(restoreSecrets(redacted, value, dynamic, dynamics)).toEqual(value);
    expect(() => restoreSecrets(redacted, {}, dynamic, dynamics)).toThrow("invalid_secret_marker");
    expect(restoreSecrets({ password: { $secret: true } }, {}, dynamic, dynamics)).toEqual({ password: "" });
    expect(() => restoreSecrets({ plain: { $secret: true } }, {}, dynamic, dynamics)).toThrow("invalid_secret_marker");
  });
  it("array deletion/reordering and dict rename restore the original source secret", () => {
    const schema = form(
      z.object({
        rows: z.array(z.object({ token: z.string().meta(secret) })),
        keys: z.record(z.string(), z.string().meta(secret)),
        plain: z.string(),
      }),
    );
    const original = { rows: [{ token: "first" }, { token: "second" }], keys: { old: "renamed" }, plain: "public" };
    const redacted = redactSecrets(original, schema) as { rows: { token: unknown }[]; keys: Record<string, unknown> };
    expect(restoreSecrets({ rows: [redacted.rows[1]], keys: { new: redacted.keys.old } }, original, schema)).toEqual({
      rows: [{ token: "second" }],
      keys: { new: "renamed" },
    });
    expect(restoreSecrets({ rows: [redacted.rows[1], redacted.rows[0]] }, original, schema)).toEqual({ rows: [{ token: "second" }, { token: "first" }] });
    for (const sourcePath of [["plain"], ["rows", "99", "token"], ["__proto__"], ["constructor"], "plain", [0]])
      expect(() => restoreSecrets({ keys: { forged: { $secret: true, sourcePath } } }, original, schema)).toThrow("invalid_secret_marker");
    expect(() => restoreSecrets({ plain: redacted.rows[0].token }, original, schema)).toThrow("invalid_secret_marker");
  });
  it("redacts and restores secret roles inside transform input wrappers", () => {
    const schema: PluginSchemaNode = { type: "object", dict: { token: { type: "transform", inner: { type: "string", meta: { role: "secret" } } } } };
    const original = { token: "transformed-private" };
    const redacted = redactSecrets(original, schema);
    expect(redacted).toEqual({ token: { $secret: true, sourcePath: ["token"] } });
    expect(restoreSecrets(redacted, original, schema)).toEqual(original);
  });
  it("redacts an array of secret strings by index and restores reordered or deleted entries", () => {
    const schema = form(z.object({ keys: z.array(z.string().meta(secret)) }));
    const original = { keys: ["k-one", "k-two", "k-three"] };
    const redacted = redactSecrets(original, schema) as { keys: unknown[] };
    expect(redacted.keys).toEqual([0, 1, 2].map((i) => ({ $secret: true, sourcePath: ["keys", String(i)] })));
    expect(restoreSecrets(redacted, original, schema)).toEqual(original);
    expect(restoreSecrets({ keys: [redacted.keys[2], redacted.keys[0], "k-new"] }, original, schema)).toEqual({ keys: ["k-three", "k-one", "k-new"] });
  });
});
