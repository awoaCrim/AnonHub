import { expect, it, vi } from "vitest";

import * as history from "../src/conversation-history.js";
import { installHistory, pollingTopic } from "../src/webui/history.js";
import { TopicRegistry } from "../src/webui/topics.js";

interface TestHttp {
  headers?: Record<string, string>;
  status?: number;
  body?: { message?: string };
  set(name: string, value: string): void;
  get(name: string): string;
}

function fakeContext() {
  const timers = new Set<() => void>();
  const routes = new Map<string, (http: TestHttp) => Promise<void>>();
  const ctx = {
    setInterval: vi.fn((fn: () => void) => {
      timers.add(fn);
      return () => timers.delete(fn);
    }),
    on: vi.fn(),
    server: { post: (path: string, handler: (http: TestHttp) => Promise<void>) => routes.set(path, handler) },
  };
  return { ctx: ctx as never, timers, routes };
}

it("polls only while subscribed and never serves members", () => {
  const { ctx, timers } = fakeContext();
  const topic = pollingTopic(ctx, "conversations", 10_000, async () => 1);
  expect(topic.authorize({ role: "member" } as never)).toBe(false);
  expect(topic.authorize({ role: "owner" } as never)).toBe(true);

  const a = vi.fn();
  const b = vi.fn();
  const offA = topic.subscribe(a);
  const offB = topic.subscribe(b);
  expect(ctx.setInterval).toHaveBeenCalledTimes(1);
  [...timers][0]();
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(1);
  offA();
  expect(timers.size).toBe(1);
  offB();
  expect(timers.size).toBe(0);
  topic.subscribe(a);
  expect(ctx.setInterval).toHaveBeenCalledTimes(2);
});

it("guards conversation detail routes by session, role and origin", async () => {
  const { ctx, routes } = fakeContext();
  const session = { current: undefined as undefined | { role: string }, sameOrigin: true };
  const auth = { sessionFromCookie: () => session.current, sameOrigin: () => session.sameOrigin };
  const registered: string[] = [];
  installHistory(ctx, auth as never, { register: (topic: { name: string }) => (registered.push(topic.name), () => {}) } as never);
  expect(registered).toEqual(["conversations"]);
  expect([...routes.keys()]).toEqual(["/yesimbot/api/v1/conversations/detail", "/yesimbot/api/v1/conversations/archive"]);

  const call = async () => {
    const headers: Record<string, string> = {};
    const http: TestHttp = {
      headers,
      set: (k, v) => {
        headers[k] = v;
      },
      get: () => "",
    };
    await routes.get("/yesimbot/api/v1/conversations/detail")!(http);
    return http;
  };
  let http = await call();
  expect([http.status, http.body?.message, http.headers?.["Cache-Control"]]).toEqual([401, "login_required", "private, no-store"]);
  session.current = { role: "member" };
  http = await call();
  expect([http.status, http.body?.message]).toEqual([403, "owner_required"]);
  session.current = { role: "owner" };
  session.sameOrigin = false;
  http = await call();
  expect([http.status, http.body?.message]).toEqual([403, "same_origin_required"]);
});
