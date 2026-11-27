import type { AgentMessage, AgentPlugin, AgentTool } from "@yesimbot/agent-runtime";
import type { ToolCapabilityScope } from "@yesimbot/contracts";
import { isComputerTool } from "@yesimbot/contracts/tools";

import { capabilityBoundary } from "../tools/capabilities.js";
import { TASK_ERRORS, taskError } from "./errors.js";

/** Explicit built-in descriptors. Undeclared extension tools are kept out of every agent by `capabilityBoundary`. */
const BUILTIN: Record<string, ToolExecutionKind> = {
  send_message: "communication",
  finish: "communication",
  reply_owner: "communication",
  task_create: "communication",
  task_status: "communication",
  task_control: "communication",
  read: "read",
  describe_image: "read",
  ctx_search: "read",
  ctx_expand: "read",
  ctx_reduce: "read",
  search_web: "read",
  search_images: "read",
  read_webpage: "read",
  query_memories: "read",
  read_evidence: "read",
  gmail: "read",
  google_calendar: "read",
  google_drive: "read",
  list_conversations: "read",
  read_conversation: "read",
  readFile: "read",
  listFiles: "read",
  bash: "content",
  writeFile: "content",
  editFile: "content",
};

const DELEGATION_SUMMARY = "\n\n当前会话可委派的后台工具（已按本平台和群聊权限过滤；每类任务都有的读取工具不列出）：";

export type ToolExecutionKind = "communication" | "read" | "computer" | "content" | "service";

export type ExecutionRole = "main" | "computer" | "content" | "service";

/** What the execution boundary reads of a tool; a declaration alone is enough. */
export type ExecutionSubject = Pick<AgentTool, "name" | "capability" | "executionKind">;

export function executionKind(tool: ExecutionSubject): ToolExecutionKind {
  if (isComputerTool(tool.name)) return "computer";
  return tool.capability?.executionKind ?? tool.executionKind ?? BUILTIN[tool.name] ?? "service";
}

/**
 * Like Muse (user, 2026-11-17: 「对齐muse的做法」; 「反正难的东西交给后台，简单的自己可以做，感觉也没必要限制只读了」):
 * the main agent may use every tool it is granted, the computer and browser included, and hands long or multi-step
 * work to a background task by its own judgement. Workers never talk to users or spawn work. Sensitive tools run
 * only for admins, checked by `capabilityBoundary`.
 *
 * A worker gets the tools of its own kind of work (user, 2026-11-19: 「按任务类型给工具」): a declaration's
 * `workers` names the tasks that may use it; otherwise its execution kind decides.
 */
export function executionAllowed(tool: ExecutionSubject, role: ExecutionRole): boolean {
  const kind = executionKind(tool);
  if (role === "main") return true;
  if (kind === "communication") return false;
  const workers = tool.capability?.workers;
  if (workers) return workers.includes(role);
  return kind === "read" || kind === role || (role === "computer" && kind === "content");
}

/** Gates the final catalog and executable closures, including tools added by extension hooks. */
export function executionBoundary(role: ExecutionRole, terminalNames: readonly string[] = []): AgentPlugin {
  const toolsByName = new Map<string, AgentTool>();
  const allowed = (tool: AgentTool) => terminalNames.includes(tool.name) || executionAllowed(tool, role);
  return {
    name: `core.execution.${role}`,
    enforce: "post",
    filterTools: (tools) =>
      tools
        .filter((tool) => {
          toolsByName.set(tool.name, tool);
          return allowed(tool);
        })
        .map((tool) =>
          typeof tool.execute !== "function"
            ? tool
            : {
                ...tool,
                execute(input, context) {
                  if (!allowed(tool)) throw taskError(TASK_ERRORS.task_tool_denied, { detail: tool.name });
                  return tool.execute(input, context);
                },
              },
        ),
    beforeToolCall: (call) => {
      const tool = toolsByName.get(call.toolName);
      return tool && allowed(tool) ? { type: "allow" } : { type: "block", reason: "该代理没有执行此工具的权限，请委派对应任务。", retry: false };
    },
  };
}

/** Host-owned gate; plugins cannot append another filter after it. */
export function runtimeToolBoundary(
  scope: ToolCapabilityScope,
  role: ExecutionRole,
  terminalNames: readonly string[] = [],
  admin?: (messages: readonly AgentMessage[]) => boolean,
): Pick<AgentPlugin, "filterTools" | "beforeToolCall"> {
  const capability = capabilityBoundary(scope, admin);
  const execution = executionBoundary(role, terminalNames);
  return {
    filterTools: async (tools, context) => {
      const admitted = (await capability.filterTools!(tools, context)) ?? [];
      return execution.filterTools!(role === "main" ? describeDelegation(admitted) : admitted, context);
    },
    beforeToolCall: async (call, context) => {
      const decision = await capability.beforeToolCall!(call, context);
      return decision?.type === "block" ? decision : execution.beforeToolCall!(call, context);
    },
  };
}

/**
 * Describe only admitted tools; a hidden main-agent tool can still belong to a worker. Reading every task can do
 * (files, search) is left out; reading only some tasks can do (mail, other conversations) is named.
 */
function describeDelegation(tools: readonly AgentTool[]): AgentTool[] {
  const everyTask = (tool: AgentTool) => (["content", "service", "computer"] as const).every((role) => executionAllowed(tool, role));
  const summary = (["content", "service", "computer"] as const)
    .map((role) => {
      const names = [
        ...new Set(
          tools
            .filter((tool) => {
              const kind = executionKind(tool);
              return kind !== "communication" && executionAllowed(tool, role) && !(kind === "read" && everyTask(tool));
            })
            .map((tool) => tool.name),
        ),
      ].sort();
      return `${role}: ${names.length ? names.join(", ") : "无可用执行工具"}`;
    })
    .join("\n");
  return tools.map((tool) =>
    tool.name === "task_create" ? { ...tool, description: (tool.description ?? "").split(DELEGATION_SUMMARY)[0] + DELEGATION_SUMMARY + "\n" + summary } : tool,
  );
}
