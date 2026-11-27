import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { BoundedResponse, httpFetch } from "@yesimbot/foundation";
import { describe, expect, it, vi } from "vitest";

import { AgentWechatClient, AgentWechatError } from "../src/index.js";

const TOKEN = "t".repeat(40);

/** What `httpFetch` hands back, for a fake that answers with a ready-made `Response`. */
function bounded(response: Response): BoundedResponse {
  return {
    url: "",
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    body: response.body,
    bytes: async () => new Uint8Array(await response.arrayBuffer()),
    text: () => response.text(),
    json: () => response.json(),
    cancel: async () => {
      await response.body?.cancel();
    },
  };
}

function respond(status: number, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }): BoundedResponse {
  return bounded(new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers }));
}

function sse(chunks: string[]): BoundedResponse {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return bounded(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
}

describe("AgentWechatClient", () => {
  it("sends the owner token and an idempotency key, and reads the daemon's error code", async () => {
    const fetch = vi.fn<typeof httpFetch>(async () => respond(409, { error: { code: "auth_required" } }));
    const client = new AgentWechatClient({ endpoint: "http://127.0.0.1:6174", token: TOKEN, fetch });
    const failure = await client.sendText("bot", { kind: "text", threadId: "wxid_a", text: "hi" }, "yesimbot:1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentWechatError);
    expect(failure).toMatchObject({ status: 409, code: "auth_required" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:6174/v1/accounts/bot/sends");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("idempotency-key")).toBe("yesimbot:1");
    expect(JSON.parse(String(init?.body))).toEqual({ kind: "text", threadId: "wxid_a", text: "hi" });
  });

  it("refuses plain HTTP to anything but loopback and invalid keys", async () => {
    expect(() => new AgentWechatClient({ endpoint: "http://10.0.0.2:6174", token: TOKEN })).toThrow("agent_wechat_endpoint_not_loopback");
    const fetch = vi.fn<typeof httpFetch>();
    const client = new AgentWechatClient({ endpoint: "http://127.0.0.1:6174", token: TOKEN, fetch });
    await expect(client.sendText("bot", { kind: "text", threadId: "x", text: "y" }, "line\nbreak")).rejects.toThrow("agent_wechat_idempotency_key_invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads the token file again once after a 401", async () => {
    const token = vi.fn<() => Promise<string>>().mockResolvedValueOnce("a".repeat(40)).mockResolvedValueOnce("b".repeat(40));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(respond(401, { error: { code: "unauthorized" } }))
      .mockResolvedValueOnce(respond(200, { items: [] }));
    const client = new AgentWechatClient({ endpoint: "http://127.0.0.1:6174", token, fetch });
    expect(await client.accounts()).toEqual([]);
    expect(token).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).get("authorization")).toBe(`Bearer ${"b".repeat(40)}`);
  });

  it("parses the event stream, taking the cursor from the event or its id line", async () => {
    const fetch = vi.fn<typeof httpFetch>(async () =>
      sse([
        ": connected\n\n",
        'id: 7\ndata: {"cursor":"7","kind":"message.committed","data":{"messageId":"msg_1","origin":"live","direction":"incoming"},"createdAt":"x"}\n\n',
        ": keepalive\n\nid: 9\ndata: ",
        '{"kind":"account.updated","data":{"accountId":"a"}}\n\n',
      ]),
    );
    const client = new AgentWechatClient({ endpoint: "http://127.0.0.1:6174", token: TOKEN, fetch });
    const events = [];
    for await (const event of client.events("bot", { after: "3" })) events.push(event);
    expect(events.map((event) => [event.cursor, event.kind])).toEqual([
      ["7", "message.committed"],
      ["9", "account.updated"],
    ]);
    expect(String(fetch.mock.calls[0]![0])).toBe("http://127.0.0.1:6174/v1/accounts/bot/events/stream?after=3");
  });

  it("reports a cursor the log no longer holds as event_cursor_expired", async () => {
    const fetch = vi.fn<typeof httpFetch>(async () => sse(['event: error\ndata: {"error":{"code":"event_cursor_expired"}}\n\n']));
    const client = new AgentWechatClient({ endpoint: "http://127.0.0.1:6174", token: TOKEN, fetch });
    const failure = await (async () => {
      for await (const _ of client.events("bot", { after: "1" })) void _;
    })().catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 410, code: "event_cursor_expired" });
  });

  it("finds the newest cursor and the account by alias", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(respond(200, { items: [], nextCursor: "42" }))
      .mockResolvedValueOnce(respond(200, { items: [{ id: "account-1", alias: "bot", ownUsername: "wxid_self", authenticated: true, connection: "online" }] }));
    const client = new AgentWechatClient({ endpoint: "http://127.0.0.1:6174/", token: TOKEN, fetch });
    expect(await client.newestCursor("bot")).toBe("42");
    expect(String(fetch.mock.calls[0]![0])).toBe("http://127.0.0.1:6174/v1/accounts/bot/events?newest=true&limit=1");
    expect((await client.findAccount("bot"))?.id).toBe("account-1");
  });

  it("reads every page of a group's members and asks WeChat for the whole list", async () => {
    const pages = [
      { items: [{ username: "wxid_a", roomDisplayName: "甲" }], nextCursor: "next page" },
      { items: [{ username: "wxid_b", nickname: "乙" }], nextCursor: null },
    ];
    const fetch = vi.fn<typeof httpFetch>(async (_url, init) =>
      init?.method === "POST" ? respond(202, { id: "op_1", accountId: "bot", kind: "metadata", state: "queued", result: null }) : respond(200, pages.shift()),
    );
    const client = new AgentWechatClient({ endpoint: "http://127.0.0.1:6174", token: TOKEN, fetch });
    expect((await client.groupMembers("bot", "1@chatroom")).map((member) => member.username)).toEqual(["wxid_a", "wxid_b"]);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:6174/v1/accounts/bot/groups/1%40chatroom/members?limit=200",
      "http://127.0.0.1:6174/v1/accounts/bot/groups/1%40chatroom/members?limit=200&cursor=next%20page",
    ]);
    expect(await client.refreshGroupMembers("bot", "1@chatroom")).toMatchObject({ id: "op_1", state: "queued" });
    expect(String(fetch.mock.calls[2]![0])).toBe("http://127.0.0.1:6174/v1/accounts/bot/groups/1%40chatroom/members/refresh");
  });

  it("asks for internal routing, and keeps an event stream open past the request timeout", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": connected\n\n");
      // The event arrives after the 100 ms request timeout: only the wait for the headers is bounded.
      setTimeout(() => response.end('id: 5\ndata: {"kind":"account.updated","data":{}}\n\n'), 250);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const client = new AgentWechatClient({ endpoint: `http://127.0.0.1:${port}`, token: TOKEN, timeoutMs: 100 });
      const events = [];
      for await (const event of client.events("bot", { after: "4" })) events.push(event);
      expect(events.map((event) => event.cursor)).toEqual(["5"]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    const fetch = vi.fn<typeof httpFetch>(async () => respond(200, { items: [] }));
    await new AgentWechatClient({ endpoint: "http://127.0.0.1:6174", token: TOKEN, fetch }).accounts();
    expect(fetch.mock.calls[0]![1]).toMatchObject({ purpose: "internal", timeoutMs: 30_000 });
  });

  it("reports a body past its limit as response_too_large", async () => {
    const fetch = vi.fn<typeof httpFetch>(async () => respond(200, "x".repeat(64), { "content-type": "image/png", "content-length": "64" }));
    const client = new AgentWechatClient({ endpoint: "http://127.0.0.1:6174", token: TOKEN, fetch });
    expect(await client.mediaContent("bot", "asset", { maxBytes: 16 }).catch((error: unknown) => error)).toMatchObject({
      status: 413,
      code: "response_too_large",
    });
  });

  it("uploads media as one multipart part named file", async () => {
    const fetch = vi.fn<typeof httpFetch>(async () => respond(201, { id: "src_1", byteLength: 3 }));
    const client = new AgentWechatClient({ endpoint: "http://127.0.0.1:6174", token: TOKEN, fetch });
    expect(await client.upload("bot", new Uint8Array([1, 2, 3]), "a.png", "image/png")).toEqual({ id: "src_1", byteLength: 3 });
    const form = fetch.mock.calls[0]![1]?.body as FormData;
    expect([...form.keys()]).toEqual(["file"]);
    expect((form.get("file") as File).name).toBe("a.png");
  });
});
