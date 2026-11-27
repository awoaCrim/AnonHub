import { readAdminLoginBody, type AdminAuth } from "../admin-auth.js";
import { collectSecretValues } from "../config/secrets.js";
import { ConfigError, ConfigStore } from "../config/store.js";
import type { Host, HttpContext } from "../host.js";
import { pluginBaseName } from "../shared/plugin-catalog.js";
import { ChangeSignal, type TopicRegistry } from "./topics.js";

/** GET fetches normally omit Origin. Explicit foreign origins and cross-site reads still fail closed. */
export function authorizeOwner(http: HttpContext, auth: AdminAuth, write = false): boolean {
  http.set("Cache-Control", "private, no-store");
  const session = auth.sessionFromCookie(http.get("cookie"));
  if (!session || session.role === "member") {
    http.status = session ? 403 : 401;
    http.body = { message: session ? "owner_required" : "login_required" };
    return false;
  }
  if ((write || http.get("origin") || http.get("sec-fetch-site") === "cross-site") && !auth.sameOrigin(http)) {
    http.status = 403;
    http.body = { message: "same_origin_required" };
    return false;
  }
  return true;
}

export function installPlugins(ctx: Host, auth: AdminAuth, topics: TopicRegistry) {
  const store = new ConfigStore(ctx);
  const catalog = store.catalog;
  const signal = new ChangeSignal();
  const logSecrets = new Set<string>();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    catalog.invalidate();
    if (!signal.size || disposed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed) signal.emit();
    }, 100);
    timer.unref?.();
  };
  const unregister = topics.register({
    name: "plugins",
    authorize: (session) => session.role !== "member",
    get: () => catalog.snapshot(),
    subscribe: (listener) => signal.subscribe(listener),
  });
  ctx.on("config", changed);
  ctx.on("internal/runtime", changed);
  ctx.on("internal/fork", changed);
  ctx.on("internal/status", changed);
  ctx.on("internal/schema", changed);
  ctx.on("dispose", () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    unregister();
  });

  const get = (route: string, handler: (http: HttpContext) => Promise<unknown>) =>
    ctx.server.get(`/yesimbot/api/v1/plugins/${route}`, async (http) => {
      if (!authorizeOwner(http, auth)) return;
      try {
        const result = await handler(http);
        if (authorizeOwner(http, auth)) http.body = result;
      } catch (error) {
        if (authorizeOwner(http, auth)) respondError(http, error);
      }
    });
  get("schema", (http) => catalog.schema(string(http.query.name)));
  get("config", (http) => store.read(string(http.query.path)));

  const post = (route: string, handler: (input: Record<string, unknown>) => Promise<unknown>) =>
    ctx.server.post(`/yesimbot/api/v1/plugins/${route}`, async (http) => {
      if (!authorizeOwner(http, auth, true)) return;
      let input: Record<string, unknown>;
      try {
        // Plugin collections can exceed login-sized bodies; keep a fixed 256 KiB bound.
        input = (await readAdminLoginBody(http, 256 * 1024)) as Record<string, unknown>;
        string(input.revision);
      } catch {
        http.status = 400;
        http.body = { message: "invalid_config" };
        return;
      }
      try {
        const result = await handler(input);
        changed();
        if (authorizeOwner(http, auth, true)) http.body = result;
      } catch (error) {
        if (authorizeOwner(http, auth, true)) respondError(http, error);
      }
    });
  post("update", async (input) => {
    if (!input.config || typeof input.config !== "object" || Array.isArray(input.config)) invalid();
    const path = string(input.path);
    let name: string;
    try {
      name = pluginBaseName(decodeURIComponent(path.split("/").at(-1)!));
    } catch {
      invalid();
    }
    const { schema, dynamics } = await catalog.schema(name!);
    // Capture submitted secrets before Loader can report an apply failure in its logs.
    // They may never become part of loader.config if the transaction rolls back.
    if (schema) for (const secret of collectSecretValues(input.config, schema, dynamics)) logSecrets.add(secret);
    else {
      const collect = (value: unknown) => {
        if (typeof value === "string" && value) logSecrets.add(value);
        else if (value && typeof value === "object") Object.values(value).forEach(collect);
      };
      collect(input.config);
    }
    return store.update(string(input.revision), path, input.config as Record<string, unknown>);
  });
  post("enabled", (input) => {
    if (typeof input.enabled !== "boolean") invalid();
    return store.setEnabled(string(input.revision), string(input.path), input.enabled as boolean);
  });
  post("add", (input) => store.add(string(input.revision), string(input.parent, true), string(input.name)));
  post("remove", (input) => store.remove(string(input.revision), string(input.path)));
  post("move", (input) => {
    if (!Number.isSafeInteger(input.index) || (input.index as number) < 0) invalid();
    return store.move(string(input.revision), string(input.path), string(input.target, true), input.index as number);
  });
  return { store, catalog, logSecrets };
}

function invalid(): never {
  throw new ConfigError(400, "invalid_config");
}

function string(value: unknown, empty = false): string {
  if (typeof value !== "string" || (!empty && !value) || value.length > 1024 || [...value].some((char) => char.charCodeAt(0) < 32)) invalid();
  return value as string;
}

function respondError(http: HttpContext, error: unknown) {
  // Never relay loader exceptions, schema messages or arbitrary error properties.
  if (error instanceof ConfigError) {
    http.status = error.status;
    http.body = {
      message: error.code,
      ...(error.path !== undefined ? { path: error.path } : {}),
      ...(error.restored !== undefined ? { restored: error.restored } : {}),
    };
  } else {
    http.status = 503;
    http.body = { message: "apply_failed", restored: false };
  }
}

export type { HttpContext };
