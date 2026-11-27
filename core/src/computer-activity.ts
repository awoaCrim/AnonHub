import { newId, systemClock, type Clock } from "@yesimbot/foundation";

const labels = {
  computer_exec: "命令行",
  computer_job: "后台命令",
  computer_use: "操作电脑",
  computer_ui: "桌面操作",
  computer_browser: "浏览器",
} as const;
const actions = new Set([
  "click",
  "double_click",
  "move",
  "drag",
  "scroll",
  "keypress",
  "type",
  "screenshot",
  "wait",
  "inspect",
  "control",
  "invoke",
  "focus",
  "setValue",
  "select",
  "expand",
  "collapse",
  "tabs",
  "navigate",
  "fill",
  "press",
  "sequence",
  "click_at",
  "clipboard_set",
  "describe",
  "list_windows",
  "get_desktop_state",
  "get_window_state",
  "run_steps",
  "type_text",
  "press_key",
  "hotkey",
  "zoom",
  "get_guide",
  "get_browser_state",
  "browser_prepare",
  "browser_navigate",
  "browser_click",
  "browser_type",
]);

export type ComputerTool = keyof typeof labels;

export interface ComputerActivityItem {
  id: string;
  at: number;
  tool: string;
  label: string;
  summary: string;
  status: "running" | "ok" | "failed";
  deviceId?: string;
  conversation?: { platform: string; channel: string; session: string };
  /**
   * The conversation (and turn) whose tool call this was, so a chat can show its own work. `toolCallId` and `runtime`
   * (the agent that called: a channel's, or `task-<id>` for a background task) find the call's input and result in
   * that agent's transcript, which is where a chat reads a card's commands and output.
   */
  origin?: { platform: string; channelId: string; turnId?: string; toolCallId?: string; runtime?: string };
}

/** Runtime-owned, bounded and ephemeral. Raw inputs/results and screenshots are never retained. */
export class ComputerActivity {
  private readonly items: ComputerActivityItem[] = [];
  private readonly listeners = new Set<(item: ComputerActivityItem) => void>();

  public constructor(private readonly clock: Clock = systemClock()) {}

  /** Called with a copy of the operation whenever one starts or ends. Returns the unsubscribe function. */
  subscribe(listener: (item: ComputerActivityItem) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private changed(item: ComputerActivityItem) {
    for (const listener of this.listeners) {
      try {
        listener(copy(item));
      } catch {
        /* Observers never affect the tool call. */
      }
    }
  }
  async record<T>(tool: ComputerTool, input: unknown, deviceId: string, execute: () => Promise<T> | T, origin?: ComputerActivityItem["origin"]): Promise<T> {
    let summary: string;
    try {
      summary = summarize(tool, input);
    } catch {
      // Display text only: a summary problem must never stop or alter the tool call.
      summary = "";
    }
    const item: ComputerActivityItem = {
      id: newId(),
      at: this.clock.now(),
      tool,
      label: labels[tool],
      summary,
      status: "running",
      deviceId,
      ...(origin ? { origin: { ...origin } } : {}),
    };
    this.items.unshift(item);
    this.items.length = Math.min(200, this.items.length);
    this.changed(item);
    let result: T;
    try {
      result = await execute();
    } catch (error) {
      item.status = "failed";
      this.changed(item);
      throw error;
    }
    item.status = operationFailed(result) ? "failed" : "ok";
    this.changed(item);
    return result;
  }
  list(deviceId?: string, limit = 50): ComputerActivityItem[] {
    return this.items
      .filter((item) => !deviceId || item.deviceId === deviceId)
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map(copy);
  }
}

/** Operation results nest at most `{status, output: {exitCode | isError}}`; the depth bound keeps this total. */
export function operationFailed(value: unknown, depth = 0): boolean {
  const result = object(value);
  return (
    result.isError === true ||
    result.ok === false ||
    result.success === false ||
    (typeof result.exitCode === "number" && result.exitCode !== 0) ||
    (typeof result.status === "string" && !["succeeded", "ok", "completed", "success"].includes(result.status)) ||
    (depth < 3 && result.output !== undefined && operationFailed(result.output, depth + 1))
  );
}

function copy(item: ComputerActivityItem): ComputerActivityItem {
  return { ...item, ...(item.conversation ? { conversation: { ...item.conversation } } : {}), ...(item.origin ? { origin: { ...item.origin } } : {}) };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Redact before truncation, including assignment/flag values and URL credentials/query/fragment.
 * Text entered into controls is deliberately omitted: password fields cannot reliably be identified.
 * Commands reach 64 KiB and this runs before the tool, so every pattern must stay linear: token-start
 * lookbehinds stop a long run (e.g. a hex payload) from being rescanned at each of its offsets.
 */
function scrub(value: string, input: Record<string, unknown> = {}): string {
  let text = value.slice(0, 65536);
  const localSecrets = [
    ...Object.values(object(input.env)),
    ...Object.entries(input)
      .filter(([key]) => /key|token|secret|pass|credential/i.test(key))
      .map(([, entry]) => entry),
  ];
  for (const secret of localSecrets) {
    if (typeof secret === "string" && secret) text = text.split(secret).join("[redacted]");
  }
  for (const [name, secret] of Object.entries(process.env)) {
    if (!secret || (secret.length < 8 && !/key|token|secret|pass|credential/i.test(name))) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) text = text.split(form).join("[redacted]");
  }
  return (
    text
      .replace(/data:[^\s]+/gi, "[redacted]")
      // Any scheme: postgres://user:pass@host and git+ssh:// carry credentials as often as https.
      .replace(/(?<![a-z\d+.-])[a-z][a-z\d+.-]{0,31}:\/\/[^\s'"<>]+/gi, (raw) => {
        try {
          const url = new URL(raw);
          return `${url.protocol}//${url.host}${url.pathname}${url.search ? "?[redacted]" : ""}`;
        } catch {
          return "[redacted]";
        }
      })
      .replace(/(?<![\w$:-])([\w$:-]+\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;|&]+)/g, "$1[redacted]")
      .replace(/(?<![\w-])(--?[\w-]+\s+)(?:"[^"]*"|'[^']*'|[^\s;|&]+)/g, "$1[redacted]")
      .replace(/\b(?:bearer|basic)\s+\S+/gi, "[redacted]")
      .replace(/\b(?:sk-|gh[pousr]_|github_pat_|AIza)[\w-]+/g, "[redacted]")
      .replace(/[A-Za-z0-9_+/=-]{24,}/g, "[redacted]")
      .replace(/"[^"]*"|'[^']*'/g, "[redacted]")
      // Intentional control-character stripping in a plain-text UI summary.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, " ")
  );
}

function action(value: unknown): string {
  return typeof value === "string" && actions.has(value) ? value : "desktop";
}

function summarize(tool: ComputerTool, input: unknown): string {
  const value = object(input);
  if (tool === "computer_exec") return scrub(typeof value.command === "string" ? value.command : "command", value).slice(0, 200);
  if (tool === "computer_job")
    return `${["read", "stop", "list"].includes(value.action as string) ? (value.action as string) : "job"}${typeof value.jobId === "string" ? ` ${value.jobId.slice(0, 8)}` : ""}`;
  if (Array.isArray(value.actions))
    return (
      value.actions
        .slice(0, 32)
        .map((entry) => {
          const step = object(entry);
          return action(step.type ?? step.action ?? step.tool);
        })
        .join(", ") || "screenshot"
    ).slice(0, 200);
  const name = action(value.tool ?? value.action ?? value.method);
  const args = object(value.args);
  if (name === "sequence" && Array.isArray(args.actions))
    return args.actions
      .slice(0, 8)
      .map((entry) => action(object(entry).tool))
      .join(", ");
  const url = value.url ?? args.url;
  return `${name}${typeof url === "string" && /^https?:\/\//i.test(url) ? ` ${scrub(url)}` : ""}`.slice(0, 200);
}
