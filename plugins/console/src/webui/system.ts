import type { AdminAuth } from "../admin-auth.js";
import type { PluginCatalog } from "../config/catalog.js";
import { collectSecretValues, isObject } from "../config/secrets.js";
import type { Host } from "../host.js";
import { pluginBaseName } from "../shared/plugin-catalog.js";
import type { LogsSnapshot, SystemSnapshot, WebUILogEntry } from "../shared/webui.js";
import { authorizeOwner } from "./plugins.js";
import { ChangeSignal, type TopicRegistry } from "./topics.js";

const secretKey = /(?:password|passwd|secret|token|api[-_]?key|credential|authorization|cookie|private[-_]?key)/i;

/** No metadata, raw errors or credentials are passed through to the browser. */
export function redactLog(text: string, secrets: Iterable<string>): string {
  const variants = new Set<string>();
  for (const value of secrets) {
    if (!value) continue;
    variants.add(value);
    variants.add(JSON.stringify(value).slice(1, -1));
    try {
      variants.add(encodeURIComponent(value));
    } catch {
      /* Lone surrogate values still match literally. */
    }
  }
  // Replace in one pass so short secrets cannot expand previously inserted markers.
  const pattern = [...variants]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const result = pattern ? text.replace(new RegExp(pattern, "g"), "[redacted]") : text;
  return result
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, "$1 [redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(
      /((?:["']?(?:password|passwd|secret|token|api[-_]?key|credential|authorization|cookie|private[-_]?key)["']?)\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;&}\]]+)/gi,
      "$1[redacted]",
    );
}

export function installSystem(ctx: Host, auth: AdminAuth, topics: TopicRegistry, catalog: PluginCatalog, secrets = new Set<string>(), tenant = false) {
  ctx.server.get("/yesimbot/api/v1/system", (http) => {
    if (!authorizeOwner(http, auth)) return;
    // The manager uses an internal owner cookie when relaying a member's child requests.
    if (tenant) {
      http.status = 403;
      http.body = { message: "owner_required" };
      return;
    }
    const config = ctx.loader.config as unknown as { port?: unknown; host?: unknown };
    const body: SystemSnapshot = {
      port: ctx.server.port ?? (typeof config.port === "number" ? config.port : null),
      host: ctx.server.listenHost ?? (typeof config.host === "string" ? config.host : ""),
      baseDir: ctx.baseDir,
      nodeVersion: process.version,
      uptime: process.uptime(),
    };
    http.body = body;
  });

  const startedAt = Math.floor(ctx.clock.now() - process.uptime() * 1000);
  const entries: WebUILogEntry[] = [];
  const signal = new ChangeSignal();
  let disposed = false;
  let refresh = Promise.resolve();
  const refreshSecrets = () => {
    let config = ctx.loader.config;
    try {
      config = structuredClone(config);
    } catch {
      /* Read-only JavaScript configs can contain functions. */
    }
    let resolved = config;
    try {
      resolved = (ctx.loader.interpolate?.(config) ?? config) as typeof config;
    } catch {
      /* Disabled entries may contain unresolved expressions. */
    }
    collectNamedSecrets(config, secrets);
    collectNamedSecrets(resolved, secrets);
    return (refresh = refresh
      .catch(() => {})
      .then(async () => {
        if (disposed) return;
        collectNamedSecrets(ctx.loader.config, secrets);
        const walk = async (tree: unknown): Promise<void> => {
          if (disposed || !isObject(tree)) return;
          for (const [key, config] of Object.entries(tree)) {
            if (key.startsWith("$")) continue;
            const name = pluginBaseName(key);
            if (name === "group") {
              await walk(config);
              continue;
            }
            try {
              const { schema, dynamics } = await catalog.schema(name);
              if (disposed) return;
              if (schema) for (const secret of collectSecretValues(config, schema, dynamics)) secrets.add(secret);
              else collectStrings(config, secrets); // Unknown schema cannot establish which values are safe.
            } catch {
              if (!disposed) collectStrings(config, secrets);
            }
          }
        };
        await walk(config.plugins);
        await walk(resolved.plugins);
      }));
  };
  // Keep previous secret values too: buffered log lines may predate a config edit.
  void refreshSecrets();
  ctx.on("config", () => {
    void refreshSecrets();
  });
  const stopLog = ctx.onLog((record) => {
    if (disposed || record.timestamp < startedAt) return;
    collectNamedSecrets(ctx.loader.config, secrets);
    entries.push({
      id: record.id,
      timestamp: record.timestamp,
      level: record.level,
      name: record.name.length > 256 ? "[logger name too large]" : record.name,
      content: record.content.length > 16_384 ? "[log entry too large]" : record.content,
    });
    if (entries.length > 500) entries.splice(0, entries.length - 500);
    if (signal.size) signal.emit();
  });
  const unregister = topics.register({
    name: "logs",
    authorize: (session) => !tenant && session.role !== "member",
    async get(): Promise<LogsSnapshot> {
      await refreshSecrets();
      return { entries: entries.map((entry) => ({ ...entry, name: redactLog(entry.name, secrets), content: redactLog(entry.content, secrets) })) };
    },
    subscribe: (listener) => signal.subscribe(listener),
  });
  ctx.on("dispose", () => {
    disposed = true;
    stopLog();
    entries.length = 0;
    secrets.clear();
    unregister();
  });
  return { stopLog };
}

function collectStrings(value: unknown, result: Set<string>) {
  if (typeof value === "string" && value) result.add(value);
  else if (value && typeof value === "object") for (const child of Object.values(value)) collectStrings(child, result);
}

function collectNamedSecrets(value: unknown, result: Set<string>) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (secretKey.test(key)) collectStrings(child, result);
    else collectNamedSecrets(child, result);
  }
}
