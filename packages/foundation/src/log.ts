import { AsyncLocalStorage } from "node:async_hooks";

import { errorFields } from "./errors.js";
import { redact } from "./redact.js";

const LEVELS: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };
const SCOPE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const EVENT = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const RESERVED = new Set(["time", "level", "scope", "event", "account", "channel", "turnId", "taskId", "requestId"]);
const MAX_STRING = 2000;
const context = new AsyncLocalStorage<LogContext>();
let minimum: number = LEVELS.info;
let sink: (record: LogRecord) => void = writeLine;
const observers = new Set<(record: LogRecord) => void>();

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface LogContext {
  readonly account?: string;
  readonly channel?: string;
  readonly turnId?: string;
  readonly taskId?: string;
  readonly requestId?: string;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface LogRecord {
  readonly time: string;
  readonly level: LogLevel;
  readonly scope: string;
  readonly event: string;
  readonly [field: string]: unknown;
}

/**
 * `logger("roleplay").warn("card.update_failed", { ...errorFields(error) })`: a dotted event name and fields, one JSON
 * line, with the current channel and turn added from the async context. Strings are redacted.
 */
export function logger(scope: string): Logger {
  if (!SCOPE.test(scope)) throw new Error(`log scope must be dotted lowercase: ${scope}`);
  const emit = (level: LogLevel) => (event: string, fields?: LogFields) => {
    if (LEVELS[level] < minimum) return;
    // A malformed name is still logged rather than thrown: log calls sit on error paths.
    const valid = EVENT.test(event);
    const record: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      scope,
      event: valid ? event : "log.malformed_event",
      ...context.getStore(),
    };
    if (!valid) record.malformedEvent = clean(event, 0);
    for (const [key, value] of Object.entries(fields ?? {})) record[RESERVED.has(key) ? `field_${key}` : key] = clean(value, 0);
    sink(record as LogRecord);
    for (const observer of observers) {
      try {
        observer(record as LogRecord);
      } catch {
        /* A reader's failure must not become another log record. */
      }
    }
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

/** Adds channel, turn and request IDs to every log line written inside `fn`, across awaits. */
export function withLogContext<T>(fields: LogContext, fn: () => T): T {
  return context.run({ ...context.getStore(), ...definedOnly(fields) }, fn);
}

/** Level and destination; the host sets them once at startup. Debug is off unless asked for. */
export function configureLogging(options: { level?: LogLevel; sink?: (record: LogRecord) => void }): void {
  if (options.level) minimum = LEVELS[options.level];
  if (options.sink) sink = options.sink;
}

/** Every record from now on, besides the sink (the console's live log page); the returned function stops it. */
export function observeLogs(observer: (record: LogRecord) => void): () => void {
  observers.add(observer);
  return () => observers.delete(observer);
}

function clean(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redact(value.length > MAX_STRING ? value.slice(0, MAX_STRING) + "…" : value);
  if (value instanceof Error) return errorFields(value);
  if (value === null || typeof value !== "object") return typeof value === "bigint" ? value.toString() : value;
  if (depth >= 4) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => clean(item, depth + 1));
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) out[key] = clean(item, depth + 1);
  return out;
}

function definedOnly(fields: LogContext): LogContext {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => typeof value === "string" && value)) as LogContext;
}

function writeLine(record: LogRecord): void {
  process.stdout.write(JSON.stringify(record) + "\n");
}
