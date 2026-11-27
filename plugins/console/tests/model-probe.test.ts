import { systemClock } from "@yesimbot/foundation";
import { describe, expect, it, vi } from "vitest";

import { probeModels, probeRequest } from "../src/model-probe.js";
import { installModelSettings } from "../src/model-settings.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("probeModels", () => {
  it("lists models per protocol with the protocol's credential header and default address", async () => {
    const calls: { url: string; headers: Record<string, string>; maxRedirects?: number }[] = [];
    const fetcher = vi.fn(async (url: URL, init: { headers: Record<string, string>; maxRedirects?: number }) => {
      calls.push({ url: String(url), headers: init.headers, maxRedirects: init.maxRedirects });
      return String(url).includes("googleapis")
        ? json({ models: [{ name: "models/gemini-b" }, { name: "models/gemini-a" }, { name: "models/gemini-a" }] })
        : json({ data: [{ id: "z" }, { id: "provider:model" }, { id: "" }, { nope: 1 }] });
    }) as never;

    expect(await probeModels({ type: "openai", baseURL: "https://api.example/v1/", apiKey: "k1" }, fetcher)).toEqual({
      ok: true,
      models: ["provider:model", "z"],
    });
    expect(await probeModels({ type: "google", baseURL: "", apiKey: "k2" }, fetcher)).toEqual({ ok: true, models: ["gemini-a", "gemini-b"] });
    await probeModels({ type: "anthropic", baseURL: "", apiKey: "k3" }, fetcher);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.example/v1/models",
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      "https://api.anthropic.com/v1/models?limit=1000",
    ]);
    expect(calls[0].headers.authorization).toBe("Bearer k1");
    expect(calls[1].headers["x-goog-api-key"]).toBe("k2");
    expect(calls[2].headers["x-api-key"]).toBe("k3");
    expect(calls.every((call) => call.maxRedirects === 0)).toBe(true);
  });

  it("maps failures to fixed codes without returning upstream content", async () => {
    const respond = (response: Response | Error) => vi.fn(async () => (response instanceof Error ? Promise.reject(response) : response)) as never;
    const target = { type: "openai", baseURL: "https://api.example/v1", apiKey: "secret-key" };
    const echo = { error: "bad key secret-key" };
    expect(await probeModels(target, respond(json(echo, 401)))).toEqual({ ok: false, models: [], error: "unauthorized" });
    expect(await probeModels(target, respond(json(echo, 404)))).toEqual({ ok: false, models: [], error: "not_found" });
    expect(await probeModels(target, respond(json(echo, 500)))).toEqual({ ok: false, models: [], error: "bad_response" });
    expect(await probeModels(target, respond(new Response("not json")))).toMatchObject({ ok: false, error: "bad_response" });
    expect(await probeModels(target, respond(json({ data: "x".repeat(1024 * 1024) })))).toMatchObject({ ok: false, error: "bad_response" });
    expect(await probeModels(target, respond(Object.assign(new Error("t"), { name: "TimeoutError" })))).toMatchObject({ error: "timeout" });
    expect(await probeModels(target, respond(new TypeError("fetch failed")))).toMatchObject({ error: "network" });
    for (const bad of [
      { ...target, type: "unknown" },
      { ...target, baseURL: "file:///etc/passwd" },
      { ...target, baseURL: "ftp://x" },
    ])
      expect(await probeModels(bad, respond(json({ data: [] })))).toMatchObject({ ok: false, error: "invalid_request" });
  });

  it("validates request bodies", () => {
    expect(probeRequest({ type: "openai", baseURL: "", key: "connection:0" })).toEqual({ type: "openai", baseURL: "", key: "connection:0" });
    expect(probeRequest({ type: "openai", baseURL: "", apiKey: "" })).toEqual({ type: "openai", baseURL: "" });
    for (const bad of [
      null,
      "x",
      { type: 1, baseURL: "" },
      { type: "openai" },
      { type: "openai", baseURL: "", apiKey: 3 },
      { type: "o".repeat(40), baseURL: "" },
    ])
      expect(probeRequest(bad)).toBeUndefined();
  });
});

describe("probe route", () => {
  function setup() {
    const provider = {
      connections: [{ type: "openai", id: "saved", apiKey: "stored-key", baseURL: "https://saved.example/v1", chatModels: [], embeddingModels: [] }],
    };
    const ctx = {
      loader: { config: { plugins: { "yesimbot-model-provider:p": provider, "yesimbot:core": {} } }, writable: true },
    };
    const routes: Record<string, Function> = {};
    const server = { get: (path: string, cb: Function) => (routes[`GET ${path}`] = cb), post: (path: string, cb: Function) => (routes[`POST ${path}`] = cb) };
    const auth = {
      config: { enabled: true },
      requireOwner: (http: { status: number; owner: boolean }) => {
        if (http.owner) return true;
        http.status = 401;
        return false;
      },
      sameOrigin: (http: { same: boolean }) => http.same,
      sessionFromCookie: () => ({ username: "owner" }),
    };
    const fetcher = vi.fn(async () => json({ data: [{ id: "m" }] }));
    installModelSettings({ ...ctx, clock: systemClock(), server } as never, auth as never, { fetcher: fetcher as never });
    const call = async (body: unknown, extra: Record<string, unknown> = {}) => {
      const http = {
        owner: true,
        same: true,
        status: 200,
        body: undefined as unknown,
        request: { body },
        set: () => {},
        get: (name: string) => (name === "content-type" ? "application/json" : ""),
        ...extra,
      };
      await routes["POST /yesimbot/model-settings/probe"](http);
      return http;
    };
    return { call, fetcher };
  }

  it("requires an owner session and same origin", async () => {
    const { call, fetcher } = setup();
    expect((await call({}, { owner: false })).status).toBe(401);
    expect((await call({}, { same: false })).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the saved key only for the saved address and never returns it", async () => {
    const { call, fetcher } = setup();
    const saved = await call({ type: "openai", baseURL: "https://saved.example/v1/", key: "connection:0" });
    expect(saved.body).toEqual({ ok: true, models: ["m"] });
    expect(JSON.stringify(saved.body)).not.toContain("stored-key");
    expect((fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1].headers).toMatchObject({ authorization: "Bearer stored-key" });
    // A changed address must not receive the stored credential.
    expect((await call({ type: "openai", baseURL: "https://attacker.example/v1", key: "connection:0" })).body).toMatchObject({ error: "missing_key" });
    expect((await call({ type: "anthropic", baseURL: "https://saved.example/v1", key: "connection:0" })).body).toMatchObject({ error: "missing_key" });
    expect((await call({ type: "openai", baseURL: "", key: "connection:9" })).body).toMatchObject({ error: "missing_key" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await call({ type: "openai", baseURL: "https://other.example/v1", apiKey: "typed" })).body).toEqual({ ok: true, models: ["m"] });
    expect((await call({ nope: true })).body).toMatchObject({ error: "invalid_request" });
  });

  it("limits outbound probes per session", async () => {
    const { call, fetcher } = setup();
    const results = [];
    for (let i = 0; i < 12; i++) results.push((await call({ type: "openai", baseURL: "", apiKey: "k" })).body);
    expect(results.filter((body) => (body as { error?: string }).error === "rate_limited")).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(10);
  });
});
