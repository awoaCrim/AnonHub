import { z } from "zod/v4";

import { AppError, defineErrors } from "./errors.js";

export const CONFIG_ERRORS = defineErrors({
  config_invalid: {
    model: "配置不符合要求，模块没有启动。",
    user: "配置不符合要求，模块没有启动，原配置已保留。",
    status: 500,
  },
  config_secret_missing: {
    model: "配置引用的密钥不存在，模块没有启动。",
    user: "配置引用的密钥在密钥文件里找不到，模块没有启动。",
    status: 500,
  },
});

/** The keys `.meta()` may set. */
export const FORM_META_KEYS: readonly (keyof FormMeta)[] = [
  "title",
  "description",
  "group",
  "hidden",
  "secret",
  "widget",
  "unit",
  "optionsSource",
  "visibleTo",
  "managed",
];

const MODULE_ID = /^[a-z][a-z0-9-]*$/;

/** The JSON Schema keywords `z.toJSONSchema` writes; with the form metadata, nothing else may appear in a form. */
const JSON_SCHEMA_KEYS = new Set([
  "$schema",
  "$ref",
  "$defs",
  "id",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
  "patternProperties",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "enum",
  "const",
  "default",
  "examples",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "readOnly",
  "writeOnly",
  "contentEncoding",
  "contentMediaType",
]);

const META_KEYS = new Set<string>(FORM_META_KEYS);

/** Chinese messages for every issue (convention 01: what people read is Chinese). */
const zhCN = z.locales.zhCN();

export type ConfigCheck<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

/** A JSON Schema node as `configForm` returns it. */
export type FormSchema = Record<string, unknown>;

/**
 * A value kept in the module's secrets file (`config/secrets/<module>.json`, convention 02 rule 4): the config holds the
 * reference, the secrets file maps the reference to the value.
 */
export type SecretRef = { readonly $secret: string };

/**
 * The form metadata a config schema may carry in `.meta()` (convention 02). Anything else is refused, so no metadata
 * exists that nothing reads.
 */
export interface FormMeta {
  readonly title?: string;
  readonly description?: string;
  /** The form section a field belongs to. */
  readonly group?: string;
  readonly hidden?: boolean;
  /** Stored apart from the config and never sent back to a browser in clear. */
  readonly secret?: boolean;
  readonly widget?: "table" | "textarea" | "path" | "slider";
  /** What a number counts (`条`, `秒`), shown beside its input. */
  readonly unit?: string;
  /** Choices the server fills in when it builds the form, for example `models.chat`. */
  readonly optionsSource?: string;
  /** Who may see the field; everyone when absent. */
  readonly visibleTo?: readonly ("owner" | "member")[];
  /** Set by the system (the runtime manager), shown read-only. */
  readonly managed?: boolean;
}

/** One module's config: the module ID and the one zod definition of its shape and defaults. */
export interface ModuleConfig<S extends z.ZodType = z.ZodType> {
  readonly id: string;
  readonly schema: S;
}

/** Where a value fails its schema, and why, in Chinese. */
export interface ConfigIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/**
 * Reads each schema's metadata from the zod that built it. One process can hold zod twice, its CommonJS and its ESM
 * build (Core's CommonJS bundle beside modules loaded as ESM), each with its own registry; `.meta()` without an argument
 * asks the right one, so `.meta()` written through either copy reaches the form.
 */
class OwnMetadata extends z.core.$ZodRegistry<z.core.GlobalMeta> {
  public override get(schema: z.core.$ZodType): z.core.GlobalMeta | undefined {
    const own = (schema as { meta?: unknown }).meta;
    return typeof own === "function" ? (own.call(schema) as z.core.GlobalMeta | undefined) : super.get(schema);
  }
}

/**
 * Names a module's config. Building its form here makes a schema with unknown metadata, or one that cannot become a
 * form, fail when the module loads rather than when someone opens the console.
 */
export function defineModuleConfig<S extends z.ZodType>(id: string, schema: S): ModuleConfig<S> {
  if (!MODULE_ID.test(id)) throw new Error(`module id must be kebab-case: ${id}`);
  configForm(schema);
  return Object.freeze({ id, schema });
}

/** Checks a raw config without throwing; the value has the defaults filled in. The raw value is never changed. */
export function checkConfig<S extends z.ZodType>(schema: S, raw: unknown): ConfigCheck<z.output<S>> {
  const result = schema.safeParse(raw, { error: zhCN.localeError });
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({ path: issue.path.map((part) => (typeof part === "symbol" ? String(part) : part)), message: issue.message })),
  };
}

/**
 * What a module starts with. A config that does not fit is `config_invalid`: the module does not start and the file is
 * left as it is (convention 02, rule 5), never reset.
 */
export function parseConfig<S extends z.ZodType>(module: ModuleConfig<S>, raw: unknown): z.output<S> {
  const result = checkConfig(module.schema, raw);
  if (result.ok) return result.value;
  throw new AppError(CONFIG_ERRORS.config_invalid, {
    effect: "none",
    detail: `${module.id}: ${result.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join(".") || "(根)"} ${issue.message}`)
      .join("；")}`,
  });
}

export function isSecretRef(value: unknown): value is SecretRef {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { $secret?: unknown }).$secret === "string"
  );
}

/**
 * The config with every secret reference replaced by its value from the module's secrets file. A reference the file
 * lacks is `config_secret_missing` (the reference goes into `detail`, never a value). The input is not changed.
 */
export function resolveSecretRefs(config: unknown, secrets: Readonly<Record<string, unknown>>, module = ""): unknown {
  if (isSecretRef(config)) {
    if (!Object.hasOwn(secrets, config.$secret))
      throw new AppError(CONFIG_ERRORS.config_secret_missing, { effect: "none", detail: `${module ? module + ": " : ""}${config.$secret}` });
    return structuredClone(secrets[config.$secret]);
  }
  if (Array.isArray(config)) return config.map((item) => resolveSecretRefs(item, secrets, module));
  if (config && typeof config === "object")
    return Object.fromEntries(Object.entries(config).map(([key, item]) => [key, resolveSecretRefs(item, secrets, module)]));
  return config;
}

/**
 * The form of a config: JSON Schema of what may be written (the input side, so defaulted fields are optional), with the
 * form metadata of `.meta()` on its nodes. Refinements and transforms only check on the server.
 */
export function configForm(schema: z.ZodType): FormSchema {
  const form = z.toJSONSchema(schema, { io: "input", unrepresentable: "any", metadata: new OwnMetadata() }) as FormSchema;
  checkFormKeys(form, "");
  return form;
}

function checkFormKeys(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => checkFormKeys(item, `${path}/${index}`));
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (!JSON_SCHEMA_KEYS.has(key) && !META_KEYS.has(key)) throw new Error(`unknown form metadata "${key}" at ${path || "/"}`);
    // Property names, defaults, examples and constants are data, not schema nodes.
    if (key === "properties" || key === "$defs" || key === "patternProperties") {
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) checkFormKeys(child, `${path}/${key}/${name}`);
    } else if (!["default", "examples", "const", "enum", "required", "visibleTo"].includes(key)) checkFormKeys(value, `${path}/${key}`);
  }
}
