import { expect, it, vi } from "vitest";

import { ApiError } from "../web/src/lib/api";
import { createConfigFieldsEditor } from "../web/src/state/config-fields";

it("merges an unrelated concurrent change but retains a conflicting service draft", async () => {
  let remote = { revision: "r1", config: { provider: "first", token: { $secret: true }, unrelated: "old" } };
  const writes: unknown[] = [];
  const request = vi.fn(async (_path: string, body?: { revision: string; config: Record<string, unknown> }) => {
    if (!body) return remote;
    writes.push(body);
    if (body.revision !== remote.revision) throw new ApiError(409, "config_changed");
    return { revision: "r3" };
  });
  const editor = createConfigFieldsEditor(["provider"], { request: request as never });
  await editor.load("service:a");
  remote = { ...remote, revision: "r2", config: { ...remote.config, unrelated: "new" } };
  editor.set(["provider"], "second");
  expect(await editor.save()).toBe(true);
  expect(writes.at(-1)).toMatchObject({ revision: "r2", config: { provider: "second", token: { $secret: true }, unrelated: "new" } });
  remote = { ...remote, revision: "r4", config: { ...remote.config, provider: "someone-else" } };
  editor.set(["provider"], "third");
  expect(await editor.save()).toBe(false);
  expect(editor.state.value.provider).toBe("third");
  expect(editor.dirty.value).toBe(true);
  editor.dispose();
});
