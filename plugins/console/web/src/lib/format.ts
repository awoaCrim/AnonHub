const pad = (part: number) => String(part).padStart(2, "0");

/**
 * Session files are named after their UTC start time (`20261029T023056Z.jsonl`);
 * older ones have no `Z`. Shown as local `MM-DD HH:mm`.
 */
export function formatSessionName(value: string): string {
  const name = value.replace(/\.jsonl$/, "");
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(name);
  if (!match) return name.slice(0, 20) || value;
  const [, y, mo, d, h, mi, s, utc] = match;
  const date = utc ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)) : new Date(+y, +mo - 1, +d, +h, +mi, +s);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** File and storage sizes: `512 B`, `3.1 KB`, `192.0 MB`, `1.2 GB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

const toDate = (value: Date | number | string) => (value instanceof Date ? value : new Date(value));

/**
 * Local times in one style. `clock` 14:05:09 · `minute` 11-07 14:05 · `second` 11-07 14:05:09 ·
 * `day` 2026/11/07. Unreadable input becomes 时间不可读 rather than "Invalid Date".
 */
export function formatTime(value: Date | number | string, style: "clock" | "minute" | "second" | "day" = "minute"): string {
  const date = toDate(value);
  if (!Number.isFinite(date.getTime())) return "时间不可读";
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (style === "clock") return `${clock}:${pad(date.getSeconds())}`;
  if (style === "day") return `${date.getFullYear()}/${day.replace("-", "/")}`;
  if (style === "second") return `${day} ${clock}:${pad(date.getSeconds())}`;
  return `${day} ${clock}`;
}

/** Connection state words used everywhere a device, account or bridge shows one. */
export const onlineLabel = (online: boolean | undefined) => (online === undefined ? "未知" : online ? "在线" : "离线");
