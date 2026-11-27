import { expect, it, vi } from "vitest";

import { ApiError } from "../web/src/lib/api";
import type { ConfigFieldsDraft } from "../web/src/state/config-fields";
import { createContextPolicyEditor } from "../web/src/state/context-policy";
import { createDraft } from "./legacy-draft-fixture";

const session = () => ({
  magicContext: { triggerTokens: 120000 },
  archive: { maxKB: 5120 },
});
function draft() {
  const data = new Map<string, string>();
  return createDraft<ConfigFieldsDraft>("policy:owner:admin", 1, {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  });
}
it("saves long-conversation fields to the shared policy and retains unshown settings", async () => {
  const request = vi.fn(async (_path, body) => ({ revision: body ? "r2" : "r1", policy: { session: body?.session ?? session() } }));
  const editor = createContextPolicyEditor(request as never);
  await editor.load("shared");
  editor.set(["session", "magicContext", "triggerTokens"], undefined);
  editor.set(["session", "ownHistoryVerbatim"], 0);
  expect(await editor.save()).toBe(true);
  expect(request.mock.calls[1]).toEqual([
    "/yesimbot/admin/context-policy",
    { revision: "r1", session: { ...session(), ownHistoryVerbatim: 0, magicContext: {} } },
    undefined,
  ]);
  // Opening a page may show the cached policy (each request costs ~1s on the public link); a save is never cached.
  expect(request.mock.calls[0]).toEqual(["/yesimbot/admin/context-policy", undefined, { fresh: false }]);
  expect(editor.dirty.value).toBe(false);
});
it("keeps a conflicting shared draft and ignores a response after the page is disposed", async () => {
  const request = vi.fn(async () => ({ revision: "r1", policy: { session: session() } }));
  const editor = createContextPolicyEditor(request as never);
  await editor.load("shared");
  editor.set(["session", "archive", "maxKB"], 2048);
  request.mockRejectedValueOnce(new ApiError(409, "context_policy_update_failed"));
  expect(await editor.save()).toBe(false);
  expect(editor.state.value.session).toMatchObject({ archive: { maxKB: 2048 } });
  expect(editor.dirty.value).toBe(true);
  let resolve!: (value: unknown) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }) as never,
  );
  const pending = editor.load("shared", false);
  editor.dispose();
  resolve({ revision: "r3", policy: { session: session() } });
  await pending;
  expect(editor.state.config).toBeUndefined();
});
