import { PassThrough } from "node:stream";

import type { AdminAuth, AdminSession } from "../admin-auth.js";
import type { Host, HttpContext } from "../host.js";
import { topicName, type TopicRegistry } from "./topics.js";

export const EVENTS_PATH = "/yesimbot/api/v1/events";
const MAX_TOPICS = 12;

export interface EventsOptions {
  heartbeatMs?: number;
  coalesceMs?: number;
}

/**
 * Server-sent events: one snapshot per topic, then coalesced full updates.
 * Plain HTTP streaming passes through the existing member relays, and a short
 * heartbeat keeps proxies (parent relay, runtime manager, Cloudflare) from idling out.
 */
export function installEvents(ctx: Host, auth: AdminAuth, topics: TopicRegistry, options: EventsOptions = {}) {
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const coalesceMs = options.coalesceMs ?? 100;
  const streams = new Map<() => void, (code?: string) => void>();
  const unsubscribeRevocation = auth.onRevocation(() => {
    for (const check of [...streams.keys()]) check();
  });
  ctx.on("dispose", () => {
    unsubscribeRevocation();
    for (const close of [...streams.values()]) close("server_closed");
  });

  ctx.server.get(EVENTS_PATH, async (http: HttpContext) => {
    http.set("Cache-Control", "private, no-store");
    const cookie = http.get("cookie");
    const session = auth.sessionFromCookie(cookie);
    if (!session) {
      http.status = 401;
      http.body = { message: "login_required" };
      return;
    }
    if ((http.get("origin") || http.get("sec-fetch-site") === "cross-site") && !auth.sameOrigin(http)) {
      http.status = 403;
      http.body = { message: "same_origin_required" };
      return;
    }
    const requested = String(http.query.topics ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const names = [...new Set(requested)];
    if (!names.length || names.length > MAX_TOPICS || names.some((name) => !topicName.test(name))) {
      http.status = 400;
      http.body = { message: "invalid_topics" };
      return;
    }
    // Missing or forbidden topics are reported individually so one optional
    // plugin (e.g. usage) cannot take down the shared stream; all-unavailable is 403.
    const selected = names.map((name) => topics.get(name)).filter((topic): topic is NonNullable<typeof topic> => !!topic && topic.authorize(session));
    const unavailable = names.filter((name) => !selected.some((topic) => topic.name === name));
    if (!selected.length) {
      http.status = 403;
      http.body = { message: "topic_forbidden" };
      return;
    }

    const stream = new PassThrough();
    http.req.socket.setTimeout(0);
    http.req.socket.setNoDelay(true);
    http.status = 200;
    http.set("Content-Type", "text/event-stream; charset=utf-8");
    http.set("X-Accel-Buffering", "no");
    http.set("Connection", "keep-alive");
    http.body = stream;

    let closed = false;
    const disposers: Array<() => unknown> = [];
    const revisions = new Map<string, number>();
    // Polling topics re-read on a timer; identical payloads are not resent over slow links.
    const lastSent = new Map<string, string>();
    const valid = () => auth.sessionFromCookie(cookie) === session;
    const write = (chunk: string) => {
      if (!closed) stream.write(chunk);
    };
    const close = (code?: string) => {
      if (closed) return;
      if (code) write(`event: closed\ndata: ${JSON.stringify({ code })}\n\n`);
      closed = true;
      for (const dispose of disposers.splice(0)) dispose();
      streams.delete(check);
      stream.end();
    };
    const check = () => {
      if (!valid()) close("session_ended");
    };
    streams.set(check, close);
    http.req.once("close", () => close());
    write(`retry: 3000\n\n`);
    for (const name of unavailable) write(`event: unavailable\ndata: ${JSON.stringify({ topic: name })}\n\n`);

    // Serialize sends per topic so updates never overtake the initial snapshot.
    const send = (topic: (typeof selected)[number], type: "snapshot" | "update") => {
      let pending: ReturnType<typeof setTimeout> | undefined;
      disposers.push(() => {
        if (pending) clearTimeout(pending);
      });
      let running = Promise.resolve();
      const emit = () =>
        (running = running.then(async () => {
          if (closed) return;
          if (!valid()) return close("session_ended");
          if (!topic.authorize(session)) {
            lastSent.delete(topic.name);
            return write(`event: unavailable\ndata: ${JSON.stringify({ topic: topic.name })}\n\n`);
          }
          let data: unknown;
          try {
            data = await topic.get(session as AdminSession);
          } catch {
            return write(`event: topic-error\ndata: ${JSON.stringify({ topic: topic.name })}\n\n`);
          }
          if (!valid()) return close("session_ended");
          if (!topic.authorize(session)) {
            lastSent.delete(topic.name);
            return write(`event: unavailable\ndata: ${JSON.stringify({ topic: topic.name })}\n\n`);
          }
          const body = JSON.stringify(data) ?? "null";
          if (lastSent.get(topic.name) === body) return;
          lastSent.set(topic.name, body);
          const revision = (revisions.get(topic.name) ?? 0) + 1;
          revisions.set(topic.name, revision);
          write(`event: ${revision === 1 ? "snapshot" : "update"}\ndata: {"topic":${JSON.stringify(topic.name)},"revision":${revision},"data":${body}}\n\n`);
        }));
      if (type === "snapshot") void emit();
      return () => {
        if (pending || closed) return;
        pending = setTimeout(() => {
          pending = undefined;
          void emit();
        }, coalesceMs);
      };
    };
    for (const topic of selected) {
      const schedule = send(topic, "snapshot");
      disposers.push(topic.subscribe(schedule));
    }
    const heartbeat = setInterval(() => {
      check();
      write(`: ping\n\n`);
    }, heartbeatMs);
    heartbeat.unref?.();
    disposers.push(() => clearInterval(heartbeat));
  });
}
