import { AppError } from "./errors.js";

export const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Where code gets "now" and the configured time zone. Tests pass a manual clock. */
export interface Clock {
  now(): number;
  readonly timeZone: string;
}

export interface ManualClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

export function systemClock(timeZone: string = DEFAULT_TIME_ZONE): Clock {
  formatter(timeZone);
  return Object.freeze({ now: () => Date.now(), timeZone });
}

export function manualClock(start: number, timeZone: string = DEFAULT_TIME_ZONE): ManualClock {
  formatter(timeZone);
  let current = start;
  return {
    now: () => current,
    timeZone,
    set: (ms) => void (current = ms),
    advance: (ms) => void (current += ms),
  };
}

/** The one time format a model or a person reads: "2026-11-23 周一 14:05（UTC+8）". */
export function formatForModel(ms: number, clock: Clock): string {
  const part = parts(ms, clock.timeZone);
  return `${part.year}-${part.month}-${part.day} ${WEEKDAYS[part.weekday]} ${part.hour}:${part.minute}（${part.offset}）`;
}

/** The calendar day of `ms` in the configured time zone: "2026-11-23". */
export function dayKey(ms: number, clock: Clock): string {
  const part = parts(ms, clock.timeZone);
  return `${part.year}-${part.month}-${part.day}`;
}

function parts(ms: number, timeZone: string) {
  if (!Number.isFinite(ms)) throw new RangeError("time must be a finite millisecond timestamp");
  const values: Record<string, string> = {};
  for (const { type, value } of formatter(timeZone).formatToParts(ms)) values[type] = value;
  const local = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour) % 24, Number(values.minute));
  const offsetMinutes = Math.round((local - Math.floor(ms / 60_000) * 60_000) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const hours = Math.floor(Math.abs(offsetMinutes) / 60);
  const minutes = Math.abs(offsetMinutes) % 60;
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: String(Number(values.hour) % 24).padStart(2, "0"),
    minute: values.minute!,
    weekday: new Date(local).getUTCDay(),
    offset: offsetMinutes === 0 ? "UTC" : `UTC${sign}${hours}${minutes ? ":" + String(minutes).padStart(2, "0") : ""}`,
  };
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (value) return value;
  try {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch (error) {
    throw new AppError("time_zone_invalid", { effect: "none", detail: timeZone, cause: error });
  }
  formatters.set(timeZone, value);
  return value;
}
