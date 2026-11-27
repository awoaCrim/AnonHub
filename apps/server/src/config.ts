import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { AppError, checkConfig, CONFIG_ERRORS, defineErrors, defineModuleConfig, readPrivateFile, resolveSecretRefs } from "@yesimbot/foundation";
import { z } from "zod/v4";

export const HOST_CONFIG_ERRORS = defineErrors({
  host_config_missing: { model: "宿主没有找到配置目录。", user: "没有找到 config/ 配置目录。", status: 500 },
  host_config_unreadable: { model: "宿主的配置文件读不出来或不是合法的 JSON。", user: "配置文件读不出来或格式不对。", status: 500 },
});

/** `config/app.json`: where the host listens and how much it logs. */
export const appConfig = defineModuleConfig(
  "app",
  z.looseObject({
    server: z
      .looseObject({
        host: z.string().default("127.0.0.1"),
        port: z.number().int().min(0).max(65535).default(5140),
      })
      .prefault({}),
    /** Koishi's scale: 0 nothing, 1 errors, 2 also info and warnings, 3 also debug. Absent: Core's `logLevel`. */
    log: z.looseObject({ level: z.number().int().min(0).max(3).optional() }).prefault({}),
  }),
);

const MAX_FILE_BYTES = 1024 * 1024;
const MODULE_FILE = /^([a-z][a-z0-9-]*)\.json$/;
const moduleFile = z.strictObject({ enabled: z.boolean(), config: z.unknown() });

export type AppConfig = z.output<typeof appConfig.schema>;

/** One module's stored entry, its secrets already put back in place. */
export interface ModuleEntry {
  readonly enabled: boolean;
  readonly config: unknown;
}

export interface HostConfig {
  readonly app: AppConfig;
  /** By module ID, as `config/<id>.json` names it. */
  readonly modules: ReadonlyMap<string, ModuleEntry>;
}

/**
 * Reads `config/` (convention 02): `app.json`, one `<module>.json` per module and `secrets/<module>.json`, which only
 * this user may read. A secret reference with no value, a file that is not JSON or not `{ enabled, config }`, or an
 * `app.json` that does not fit refuses the start; nothing is rewritten.
 */
export async function loadHostConfig(stateDir: string): Promise<HostConfig> {
  const dir = join(stateDir, "config");
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch (error) {
    throw new AppError(HOST_CONFIG_ERRORS.host_config_missing, { effect: "none", detail: dir, cause: error });
  }
  const app = names.includes("app.json") ? checkConfig(appConfig.schema, await readJson(join(dir, "app.json"))) : checkConfig(appConfig.schema, {});
  if (!app.ok)
    throw new AppError(CONFIG_ERRORS.config_invalid, {
      effect: "none",
      detail: `app: ${app.issues.map((issue) => `${issue.path.join(".") || "(根)"} ${issue.message}`).join("；")}`,
    });
  const modules = new Map<string, ModuleEntry>();
  const secretNames = new Set(await secretFiles(join(dir, "secrets")));
  for (const name of names) {
    const id = MODULE_FILE.exec(name)?.[1];
    if (!id || id === "app") continue;
    const parsed = moduleFile.safeParse(await readJson(join(dir, name)));
    if (!parsed.success) throw new AppError(HOST_CONFIG_ERRORS.host_config_unreadable, { effect: "none", detail: `${name}: 应为 { enabled, config }` });
    const secrets = secretNames.has(name) ? await readSecrets(join(dir, "secrets", name)) : {};
    modules.set(id, { enabled: parsed.data.enabled, config: resolveSecretRefs(parsed.data.config, secrets, id) });
  }
  return { app: app.value, modules };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse((await readPrivateFile(path, { maxBytes: MAX_FILE_BYTES })).toString("utf8"));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(HOST_CONFIG_ERRORS.host_config_unreadable, { effect: "none", detail: path, cause: error });
  }
}

async function readSecrets(path: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse((await readPrivateFile(path, { maxBytes: MAX_FILE_BYTES, mode0600: true })).toString("utf8"));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(HOST_CONFIG_ERRORS.host_config_unreadable, { effect: "none", detail: path, cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError(HOST_CONFIG_ERRORS.host_config_unreadable, { effect: "none", detail: `${path}: 应为 { "<JSON Pointer>": 值 }` });
  return value as Record<string, unknown>;
}

async function secretFiles(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
