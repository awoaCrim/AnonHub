import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { manualClock } from "@yesimbot/foundation";
import { describe, it, expect, vi } from "vitest";

import { BotHookStore, installBotHooks } from "../src/webui/bot-hooks";
vi.mock("../src/webui/plugins.js", () => ({ authorizeOwner: (http: { owner?: boolean }) => http.owner === true }));
vi.mock("../src/admin-auth.js", () => ({ readAdminLoginBody: async (http: { input?: unknown }) => http.input }));

type HookHttp = {
  owner: boolean;
  input: unknown;
  params: Record<string, string>;
  set: () => void;
  get: () => string;
  body: { bots: Array<{ platform: string; path: string }> } | undefined;
  status: number;
};

describe("Bot capability hooks", () => {
  it("persists tokens, rotates/revokes old capabilities and fails closed on restart ambiguity", async () => {
    const root = mkdtempSync(join(tmpdir(), "bot-hook-"));
    try {
      const file = join(root, "hooks.json"),
        store = new BotHookStore(file);
      const hook = await store.change("onebot", "123", "create"),
        old = hook.token;
      expect(new BotHookStore(file).authenticate(hook.id, old)?.selfId).toBe("123");
      expect(store.authenticate(hook.id, "界".repeat(64))).toBeUndefined();
      await store.change("onebot", "123", "rotate");
      expect(store.authenticate(hook.id, old)).toBeUndefined();
      expect(store.authenticate(hook.id, hook.token)).toBeDefined();
      await store.change("onebot", "123", "disable");
      expect(store.authenticate(hook.id, hook.token)).toBeUndefined();
      store.receipts.push({ id: "evt", hook: hook.id, state: "processing", at: 1_000 });
      await store.save();
      expect(new BotHookStore(file).receipts[0].state).toBe("uncertain");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("routes to the bound Bot without taking arbitrary targets from the caller; deduplicates and rejects revoked links", async () => {
    const root = mkdtempSync(join(tmpdir(), "bot-hook-api-"));
    try {
      const routes = new Map<string, (http: HookHttp) => Promise<void>>();
      const post = vi.fn(async () => undefined);
      const ctx = {
        baseDir: root,
        clock: manualClock(1_700_000_000_000),
        bots: [
          { platform: "onebot", selfId: "qq", status: 1 },
          { platform: "wechat-bridge", selfId: "wx", status: 1 },
        ],
        server: {
          get: (path: string, fn: (http: HookHttp) => Promise<void>) => routes.set(`GET ${path}`, fn),
          post: (path: string, fn: (http: HookHttp) => Promise<void>) => routes.set(`POST ${path}`, fn),
        },
        yesimbot: { messenger: { post } },
      };
      installBotHooks(ctx as never, {} as never);
      const http = (input = {}, params: Record<string, string> = {}): HookHttp => ({
        owner: true,
        input,
        params,
        set: vi.fn(),
        get: () => "",
        body: undefined,
        status: 200,
      });
      const create = http({ platform: "wechat-bridge", selfId: "wx", action: "create" });
      await routes.get("POST /yesimbot/api/v1/bot-hooks")!(create);
      const path = create.body!.bots.find((bot) => bot.platform === "wechat-bridge")!.path.split("/");
      const params = { id: path.at(-2), token: path.at(-1) };
      const receive = routes.get("POST /yesimbot/hooks/:id/:token")!;
      const request = http({ content: "build ready", event_id: "build-1", platform: "onebot", selfId: "qq" }, params);
      await receive(request);
      expect(request.status).toBe(202);
      expect(post.mock.calls[0][0]).toMatchObject({ platform: "wechat-bridge", selfId: "wx" });
      await receive(http({ content: "changed", event_id: "build-1" }, params));
      expect(post).toHaveBeenCalledTimes(1);
      const invalid = http({ content: "hi" }, { ...params, token: "f".repeat(64) });
      await receive(invalid);
      expect(invalid.status).toBe(404);
      const missing = http({}, params);
      await receive(missing);
      expect(missing.status).toBe(400);
      await routes.get("POST /yesimbot/api/v1/bot-hooks")!(http({ platform: "wechat-bridge", selfId: "wx", action: "disable" }));
      const disabled = http({ content: "hi" }, params);
      await receive(disabled);
      expect(disabled.status).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("never exposes or creates a public hook for the built-in web chat", async () => {
    const root = mkdtempSync(join(tmpdir(), "bot-hook-web-"));
    try {
      type Http = { owner: boolean; input: unknown; params: object; set: () => void; get: () => string; body: unknown; status: number };
      const routes = new Map<string, (http: Http) => Promise<void>>();
      const register = (method: string) => (path: string, fn: (http: Http) => Promise<void>) => routes.set(`${method} ${path}`, fn);
      const ctx = {
        baseDir: root,
        clock: manualClock(1_700_000_000_000),
        bots: [
          { platform: "onebot", selfId: "qq", status: 1 },
          { platform: "web", selfId: "bot", status: 1 },
        ],
        server: { get: register("GET"), post: register("POST") },
        yesimbot: { messenger: { post: vi.fn() } },
      };
      installBotHooks(ctx as never, {} as never);
      const http = (input: unknown = {}): Http => ({ owner: true, input, params: {}, set: vi.fn(), get: () => "", body: undefined, status: 200 });
      const list = http();
      await routes.get("GET /yesimbot/api/v1/bot-hooks")!(list);
      expect((list.body as { bots: { platform: string }[] }).bots.map((bot) => bot.platform)).toEqual(["onebot"]);
      const create = http({ platform: "web", selfId: "bot", action: "create" });
      await routes.get("POST /yesimbot/api/v1/bot-hooks")!(create);
      expect([create.status, create.body]).toEqual([400, { message: "hook_update_failed" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
