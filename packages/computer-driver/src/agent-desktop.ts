import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * The agent-desktop commands a bot may use (each is the MCP tool `desktop_<name>`). Left out: notifications
 * and system surfaces, sessions, tracing, skills, and the key/mouse "hold" commands that fail closed anyway.
 */
export const AGENT_DESKTOP_TOOLS = [
  "snapshot",
  "find",
  "get",
  "is",
  "screenshot",
  "click",
  "double_click",
  "triple_click",
  "right_click",
  "type",
  "set_value",
  "clear",
  "focus",
  "select",
  "toggle",
  "check",
  "uncheck",
  "expand",
  "collapse",
  "scroll",
  "scroll_to",
  "press",
  "hover",
  "drag",
  "mouse_move",
  "mouse_click",
  "mouse_wheel",
  "launch",
  "close_app",
  "list_apps",
  "list_windows",
  "list_displays",
  "focus_window",
  "resize_window",
  "move_window",
  "minimize",
  "maximize",
  "restore",
  "clipboard_get",
  "clipboard_set",
  "wait",
] as const;

export const AGENT_DESKTOP_COMMANDS = ["describe", ...AGENT_DESKTOP_TOOLS, "sequence"] as const;

export const MAX_DESKTOP_SEQUENCE_ACTIONS = 8;

/** Commands that look without changing anything: no screenshot is taken after them. */
const READS = new Set<string>(["snapshot", "find", "get", "is", "screenshot", "list_apps", "list_windows", "list_displays", "clipboard_get", "wait"]);

export type AgentDesktopTool = (typeof AGENT_DESKTOP_TOOLS)[number];

export interface AgentDesktopOutput {
  text: string;
  isError: boolean;
  data?: string;
  mediaType?: string;
  /** Whether the command was repeated with real mouse and keyboard input after the quiet attempt was refused. */
  physical?: boolean;
}

/**
 * agent-desktop over MCP. Every command is first tried without moving the pointer or taking focus; one the
 * desktop refuses that way (typing into a web page, the wheel, drags) is repeated once with real input when
 * `physicalInput` allows it. Refs are scoped to their snapshot, so conversations need no sessions of their own.
 */
export class AgentDesktopClient {
  private readonly clients = new Map<"quiet" | "physical", Client>();
  constructor(
    private readonly command: string,
    private readonly options: { physicalInput?: boolean; env?: Record<string, string> } = {},
  ) {}
  private async connect(mode: "quiet" | "physical", signal: AbortSignal): Promise<Client> {
    const existing = this.clients.get(mode);
    if (existing) return existing;
    const client = new Client({ name: "yesimbot-desktop", version: "1.0" });
    const transport = new StdioClientTransport({
      command: this.command,
      args: mode === "physical" ? ["mcp", "--headed"] : ["mcp"],
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        ...this.options.env,
      },
    });
    try {
      await client.connect(transport, { signal });
    } catch (error) {
      await transport.close();
      throw error;
    }
    this.clients.set(mode, client);
    return client;
  }
  async call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<AgentDesktopOutput> {
    signal.throwIfAborted();
    if (tool === "sequence") return this.sequence(args, signal);
    if (tool !== "describe" && !AGENT_DESKTOP_TOOLS.includes(tool as AgentDesktopTool)) throw new Error("unsupported_desktop_tool");
    if (tool === "describe") {
      const client = await this.connect("quiet", signal);
      const catalog = await client.listTools({}, { signal });
      const wanted = (name: string) =>
        AGENT_DESKTOP_TOOLS.includes(name.replace(/^desktop_/, "") as AgentDesktopTool) && (!args.tool || name === `desktop_${args.tool}`);
      return {
        text: JSON.stringify(catalog.tools.filter((t) => wanted(t.name)).map((t) => ({ ...t, name: t.name.replace(/^desktop_/, "") }))).slice(0, 30000),
        isError: false,
      };
    }
    const output = await this.act(tool, args, signal);
    // An action answers with what the screen looks like now, so the next step starts from the result.
    return !output.isError && !READS.has(tool) && !output.data ? this.withScreenshot(output, signal) : output;
  }
  /** One device operation, no intermediate screenshots and no replay after a failed/uncertain step. */
  private async sequence(args: Record<string, unknown>, signal: AbortSignal): Promise<AgentDesktopOutput> {
    if (desktopSequenceProblem(args)) throw new Error("invalid_desktop_sequence");
    const actions = args.actions as Array<{ tool: AgentDesktopTool; args?: Record<string, unknown> }>;
    const results: Array<{ tool: string; text: string; isError: boolean; physical?: boolean }> = [];
    let failedAt: number | undefined;
    for (const step of actions) {
      signal.throwIfAborted();
      const output = await this.act(step.tool, step.args ?? {}, signal);
      results.push({ tool: step.tool, text: output.text.slice(0, 2000), isError: output.isError, ...(output.physical ? { physical: true } : {}) });
      if (output.isError) {
        failedAt = results.length - 1;
        break;
      }
    }
    return this.withScreenshot(
      {
        text: JSON.stringify({
          ok: failedAt === undefined,
          completed: results.length - (failedAt === undefined ? 0 : 1),
          total: actions.length,
          ...(failedAt === undefined ? {} : { failedAt, recovery: "Inspect the current state; do not replay the sequence." }),
          results,
        }),
        isError: failedAt !== undefined,
      },
      signal,
    );
  }
  private async act(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<AgentDesktopOutput> {
    signal.throwIfAborted();
    // Snapshots are for finding things to act on: interactive elements, collapsed, unless asked otherwise.
    const input = tool === "snapshot" ? { interactive_only: true, compact: true, ...args } : args;
    let output = await this.run("quiet", tool, input, signal);
    if (output.isError && this.options.physicalInput !== false && refusedQuietly(output.text)) {
      output = { ...(await this.run("physical", tool, input, signal)), physical: true };
    }
    return output;
  }
  private async withScreenshot(output: AgentDesktopOutput, signal: AbortSignal): Promise<AgentDesktopOutput> {
    signal.throwIfAborted();
    const shot = await this.run("quiet", "screenshot", {}, signal).catch(() => undefined);
    signal.throwIfAborted();
    // Preserve scale_factor metadata as plain text for the screen-coordinate adapter.
    return shot?.data ? { ...output, data: shot.data, mediaType: shot.mediaType, text: `${output.text}\n${shot.text}` } : output;
  }
  private async run(mode: "quiet" | "physical", tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<AgentDesktopOutput> {
    signal.throwIfAborted();
    const client = await this.connect(mode, signal);
    const result = await client.callTool({ name: `desktop_${tool}`, arguments: args }, undefined, { signal, timeout: 60_000 });
    const blocks = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    const image = blocks.find((b) => b.type === "image");
    if (image && (!image.data || image.data.length > 16 * 1024 * 1024 || !["image/png", "image/jpeg"].includes(image.mimeType ?? "")))
      throw new Error("invalid_desktop_image");
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
    return {
      text: text.slice(0, 30000),
      isError: result.isError === true || envelopeFailed(text),
      ...(image ? { data: image.data!, mediaType: image.mimeType! } : {}),
    };
  }
  async close() {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
  }
}

/**
 * What makes `sequence` arguments malformed, for the model to correct; undefined when they are well formed.
 * A malformed sequence runs no step, so callers report it as refused, never as an uncertain result.
 */
export function desktopSequenceProblem(args: Record<string, unknown>): string | undefined {
  const extra = Object.keys(args).filter((key) => key !== "actions");
  if (extra.length) return `args 只能有 actions，不能有 ${extra.join("、")}`;
  const actions: unknown = args.actions;
  if (!Array.isArray(actions) || !actions.length) return "args.actions 必须是非空数组";
  if (actions.length > MAX_DESKTOP_SEQUENCE_ACTIONS) return `最多 ${MAX_DESKTOP_SEQUENCE_ACTIONS} 步`;
  for (const [index, value] of actions.entries()) {
    const step = `第 ${index + 1} 步`;
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${step}必须是 {tool, args} 对象`;
    const { tool, args: stepArgs, ...rest } = value as Record<string, unknown>;
    if (Object.keys(rest).length) return `${step}只能有 tool 和 args，${Object.keys(rest).join("、")} 要放进 args`;
    if (!AGENT_DESKTOP_TOOLS.includes(tool as AgentDesktopTool)) return `${step}的 tool ${JSON.stringify(tool ?? null)} 不是可用动作`;
    if (stepArgs !== undefined && (!stepArgs || typeof stepArgs !== "object" || Array.isArray(stepArgs))) return `${step}的 args 必须是对象`;
    const ms = (stepArgs as { ms?: unknown } | undefined)?.ms;
    if (tool === "wait" && (typeof ms !== "number" || !Number.isInteger(ms) || ms < 0 || ms > 1000)) return `${step}的 wait 要写 args.ms，0 到 1000 的整数`;
  }
  return undefined;
}

/**
 * The quiet attempt never reached the app and may safely be repeated with real input: refused by policy
 * (headless typing into a web page, the wheel), or reported as not delivered with a safe retry.
 */
export function refusedQuietly(text: string): boolean {
  try {
    const error = (JSON.parse(text) as { error?: { code?: string; disposition?: { delivery?: string; retry?: string } } }).error;
    if (!error) return false;
    return (
      error.code === "POLICY_DENIED" || (error.disposition?.delivery === "not_delivered" && error.disposition.retry === "safe" && error.code !== "INVALID_ARGS")
    );
  } catch {
    return false;
  }
}

/** agent-desktop answers with a JSON envelope; `ok: false` is a failure even when MCP reports success. */
function envelopeFailed(text: string): boolean {
  try {
    return (JSON.parse(text) as { ok?: unknown }).ok === false;
  } catch {
    return false;
  }
}
