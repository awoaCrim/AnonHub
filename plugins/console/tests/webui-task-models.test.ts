import { expect, it, vi } from "vitest";

import { TASK_ERRORS, taskError } from "../../../core/src/tasks/errors.js";
import { installTasks } from "../src/webui/tasks.js";
import { TopicRegistry } from "../src/webui/topics.js";

function fixture() {
  const routes = new Map<string, (http: unknown) => unknown>();
  const tasks = {
    subscribe: () => () => {},
    store: { list: vi.fn(async () => []) },
    cancel: vi.fn(),
    update: vi.fn(),
    resolveHandoff: vi.fn(),
  };
  const current = { session: { role: "owner" } as { role: string } | undefined, sameOrigin: true };
  const ctx = {
    yesimbot: { tasks },
    on: vi.fn(),
    // Core is handed over the way Koishi does once it is up.
    inject: vi.fn((_deps: unknown, callback: (scope: unknown) => void) => callback({ yesimbot: { tasks }, on: vi.fn() })),
    server: {
      get: (path: string, handler: (http: unknown) => unknown) => routes.set("GET " + path, handler),
      post: (path: string, handler: (http: unknown) => unknown) => routes.set("POST " + path, handler),
    },
  };
  installTasks(ctx as never, { sessionFromCookie: () => current.session, sameOrigin: () => current.sameOrigin } as never, new TopicRegistry());
  const id = "11111111-1111-4111-8111-111111111111";
  return {
    tasks,
    current,
    request: async (action: "update" | "resolve-handoff", extra: Record<string, unknown> = {}) => {
      const http = {
        status: 200,
        body: undefined as unknown,
        set: vi.fn(),
        get: () => "application/json",
        request: {
          body: {
            id,
            action,
            instruction: "continue",
            ...(action === "resolve-handoff" ? { handoffId: id } : {}),
            ...extra,
          },
        },
      };
      await routes.get("POST /yesimbot/api/v1/tasks/update")!(http);
      return http;
    },
  };
}

it.each(["update", "resolve-handoff"] as const)("returns the safe model validation error from %s without hiding its reason", async (action) => {
  const h = fixture();
  const error = taskError(TASK_ERRORS.task_model_not_allowed);
  const update = action === "update" ? h.tasks.update : h.tasks.resolveHandoff;
  update.mockRejectedValueOnce(error);
  const http = await h.request(action);
  expect(http.status).toBe(400);
  expect(http.body).toEqual({ message: error.message, code: error.code });
  update.mockRejectedValueOnce(taskError(TASK_ERRORS.task_model_unavailable));
  expect((await h.request(action)).body).toMatchObject({ code: "task_model_unavailable" });
  update.mockRejectedValueOnce(new Error("private provider credentials"));
  expect((await h.request(action)).body).toEqual({ message: "task_update_failed" });
});

it("keeps task model policy on the authenticated instance and rejects client routing fields", async () => {
  const h = fixture();
  h.current.session = { role: "member" };
  expect((await h.request("update")).status).toBe(403);
  h.current.session = { role: "owner" };
  h.current.sameOrigin = false;
  expect((await h.request("update")).status).toBe(403);
  h.current.sameOrigin = true;
  expect((await h.request("update", { model: "other:model" })).status).toBe(400);
  expect((await h.request("update", { tenant: "other" })).status).toBe(400);
  expect(h.tasks.update).not.toHaveBeenCalled();
});

// A page left open during a restart asks for tasks before Core is up: the answer is "not ready", without
// reading the unregistered service (which made Koishi warn on every restart).
it("answers 'not ready' before Core is up, without reading the service", async () => {
  const routes = new Map<string, (http: unknown) => unknown>();
  const topics = new TopicRegistry();
  const ctx = {
    get yesimbot(): never {
      throw new Error("read before Core is up");
    },
    on: vi.fn(),
    inject: vi.fn(),
    server: {
      get: (path: string, handler: (http: unknown) => unknown) => routes.set("GET " + path, handler),
      post: (path: string, handler: (http: unknown) => unknown) => routes.set("POST " + path, handler),
    },
  };
  installTasks(ctx as never, { sessionFromCookie: () => ({ role: "owner" }), sameOrigin: () => true } as never, topics);
  const http = { status: 200, body: undefined as unknown, set: vi.fn(), get: () => "", query: {} };
  await routes.get("GET /yesimbot/api/v1/tasks")!(http);
  expect(http).toMatchObject({ status: 503, body: { message: "tasks_unavailable" } });
  await expect(topics.get("tasks")!.get({ role: "owner" } as never)).rejects.toThrow("runtime_not_ready");
});
