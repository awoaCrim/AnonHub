import { expect, it, vi } from "vitest";

import { installHistory } from "../src/webui/history.js";
import { TopicRegistry } from "../src/webui/topics.js";

interface Http {
  status: number;
  body: unknown;
  set: ReturnType<typeof vi.fn>;
  get(name: string): string;
  request: { body: unknown };
}

function fixture() {
  const routes = new Map<string, (http: Http) => Promise<void>>();
  const archive = vi.fn(async (_request: unknown) => {});
  let session: object | undefined = { role: "owner" };
  let sameOrigin = true;
  const topics = new TopicRegistry();
  installHistory(
    {
      on: vi.fn(),
      setInterval: () => () => {},
      yesimbot: { conversation: { archive } },
      server: { post: (path: string, fn: (http: Http) => Promise<void>) => routes.set(path, fn) },
    } as never,
    { sessionFromCookie: () => session, sameOrigin: () => sameOrigin } as never,
    topics,
  );
  return {
    archive,
    topics,
    session: (value: object | undefined) => {
      session = value;
    },
    origin: (value: boolean) => {
      sameOrigin = value;
    },
    call: async (body: unknown = { channel: "direct-v2-qq-bot-user", session: "20261103.jsonl" }) => {
      const http: Http = {
        status: 200,
        body: undefined,
        set: vi.fn(),
        get: (name: string) => (name === "content-type" ? "application/json" : "cookie"),
        request: { body },
      };
      await routes.get("/yesimbot/api/v1/conversations/archive")!(http);
      return http;
    },
  };
}

it("requires a local owner session and origin, denying members on the parent", async () => {
  const f = fixture();
  f.session(undefined);
  expect((await f.call()).status).toBe(401);
  f.session({ role: "member", accountId: "member-a" });
  expect((await f.call()).status).toBe(403);
  f.session({ role: "owner" });
  f.origin(false);
  expect((await f.call()).status).toBe(403);
  expect(f.archive).not.toHaveBeenCalled();
});

it("archives only the exact local request and immediately refreshes subscribed history", async () => {
  const f = fixture();
  const notify = vi.fn();
  const off = f.topics.get("conversations")!.subscribe(notify);
  const result = await f.call();
  expect(result.body).toEqual({ archived: true });
  expect(f.archive).toHaveBeenCalledExactlyOnceWith({ channel: "direct-v2-qq-bot-user", session: "20261103.jsonl" });
  expect(notify).toHaveBeenCalledOnce();
  off();
});

it("rejects routing overrides, invalid sessions and path traversal before reaching Core", async () => {
  const f = fixture();
  for (const body of [
    { channel: "a", session: "a.jsonl", accountId: "other" },
    { channel: "../owner", session: "a.jsonl" },
    { channel: "a\\b", session: "a.jsonl" },
    { channel: "a", session: "../a.jsonl" },
    { channel: "a", session: "" },
    null,
  ])
    expect((await f.call(body)).status).toBe(400);
  expect(f.archive).not.toHaveBeenCalled();
});

it.each([
  ["conversation_changed", 409],
  ["conversation_empty", 409],
  ["conversation_not_found", 404],
  ["private/path secret", 500],
])("reports a safe archive failure for %s", async (code, status) => {
  const f = fixture();
  f.archive.mockRejectedValueOnce(new Error(String(code)));
  const result = await f.call();
  expect(result.status).toBe(status);
  expect(result.body.message).toBe(status === 500 ? "conversation_archive_failed" : code);
});
