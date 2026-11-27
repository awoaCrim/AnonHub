import { readAdminLoginBody, type AdminAuth } from "../admin-auth.js";
import type { Host } from "../host.js";
import type { TaskStepsResponse } from "../shared/work.js";
import { authorizeOwner } from "./plugins.js";
import { ChangeSignal, type TopicRegistry } from "./topics.js";

/** The authenticated tenant relay selects the instance; no tenant argument is accepted. */
export function installTasks(ctx: Host, auth: AdminAuth, topics: TopicRegistry) {
  const signal = new ChangeSignal();
  /** Core while it runs. Reading the service before Core is up (a page open during a restart) warns and fails. */
  let core: Host["yesimbot"] | undefined;
  const tasks = () => {
    if (!core) throw new Error("runtime_not_ready");
    return core.tasks;
  };
  ctx.inject(["yesimbot"], (scope) => {
    const current = scope.yesimbot;
    core = current;
    const off = current.tasks.subscribe(() => signal.emit());
    scope.on("dispose", () => {
      off();
      if (core === current) core = undefined;
      signal.emit();
    });
    signal.emit();
  });
  /** Archived tasks stay out of the console; the bot's task tools still read them. */
  const listed = async () => (await tasks().store.list()).filter((task) => !task.archivedAt);
  const unregister = topics.register({
    name: "tasks",
    authorize: (session) => session.role === "owner",
    get: async () => ({ items: await listed() }),
    subscribe: (listener) => signal.subscribe(listener),
  });
  ctx.on("dispose", unregister);
  ctx.server.get("/yesimbot/api/v1/tasks", async (http) => {
    if (!authorizeOwner(http, auth)) return;
    try {
      const items = await listed();
      if (authorizeOwner(http, auth)) http.body = { items };
    } catch {
      http.status = 503;
      http.body = { message: "tasks_unavailable" };
    }
  });
  /**
   * A task's steps so far, from `from` on (user, 2026-11-20: 「我点开这个后台任务不就是为了看进度吗？至少我得知道，执行了哪些命令，
   * 正在执行什么命令吧？」). The panel asks again from its first step still running while the task runs.
   */
  ctx.server.get("/yesimbot/api/v1/tasks/steps", async (http) => {
    if (!authorizeOwner(http, auth)) return;
    const id = String(http.query.id ?? "");
    const from = Number(http.query.from ?? 0);
    if (!/^[a-f0-9-]{36}$/.test(id) || !Number.isSafeInteger(from) || from < 0) {
      http.status = 400;
      http.body = { message: "invalid_task_request" };
      return;
    }
    try {
      const steps: TaskStepsResponse = await tasks().steps(id, from);
      if (authorizeOwner(http, auth)) http.body = steps;
    } catch (error) {
      const missing = error instanceof Error && error.message === "task_not_found";
      http.status = missing ? 404 : 503;
      http.body = { message: missing ? "task_not_found" : "tasks_unavailable" };
    }
  });
  /** `{ ids, archived }`: archives finished tasks, or brings them back (the toast's 撤销); answers the IDs it changed. */
  ctx.server.post("/yesimbot/api/v1/tasks/archive", async (http) => {
    if (!authorizeOwner(http, auth, true)) return;
    let body: Record<string, unknown>;
    try {
      body = (await readAdminLoginBody(http, 12000)) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const ids = body.ids;
    if (
      Object.keys(body).some((key) => key !== "ids" && key !== "archived") ||
      typeof body.archived !== "boolean" ||
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 200 ||
      ids.some((id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
    ) {
      http.status = 400;
      http.body = { message: "invalid_task_request" };
      return;
    }
    try {
      const changed = await tasks().archive(ids as string[], body.archived);
      if (authorizeOwner(http, auth, true)) http.body = { ids: changed };
    } catch {
      http.status = 503;
      http.body = { message: "tasks_unavailable" };
    }
  });
  ctx.server.post("/yesimbot/api/v1/tasks/update", async (http) => {
    if (!authorizeOwner(http, auth, true)) return;
    try {
      const session = auth.sessionFromCookie(http.get("cookie"));
      const body = (await readAdminLoginBody(http, 12000)) as Record<string, unknown>;
      if (
        Object.keys(body).some((key) => !["id", "action", "instruction", "handoffId"].includes(key)) ||
        typeof body.id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(body.id)
      )
        throw Error("invalid_task_request");
      if (auth.sessionFromCookie(http.get("cookie")) !== session) {
        http.status = 401;
        http.body = { message: "login_required" };
        return;
      }
      if (body.action === "cancel") http.body = await tasks().cancel(body.id);
      else if (
        body.action === "resolve-handoff" &&
        typeof body.handoffId === "string" &&
        /^[a-f0-9-]{36}$/.test(body.handoffId) &&
        (body.instruction === undefined || (typeof body.instruction === "string" && body.instruction.length <= 8000))
      )
        http.body = await tasks().resolveHandoff(body.id, body.handoffId, (body.instruction as string | undefined) ?? "");
      else if (body.action === "update" && typeof body.instruction === "string" && body.instruction.trim() && body.instruction.length <= 8000)
        http.body = await tasks().update(body.id, body.instruction.trim());
      else throw Error("invalid_task_request");
    } catch (error) {
      http.status = 400;
      const code = error instanceof Error && error.name === "AppError" && "code" in error && typeof error.code === "string" ? error.code : undefined;
      const modelError = code === "task_model_not_allowed" || code === "task_model_unavailable";
      http.body =
        modelError || (code && ["task_not_found", "task_handoff_stale", "task_handoff_not_ready"].includes(code))
          ? { message: code, ...(modelError ? { code } : {}) }
          : { message: "task_update_failed" };
    }
  });
}
