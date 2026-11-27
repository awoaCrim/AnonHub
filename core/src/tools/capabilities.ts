import type { AgentMessage, AgentPlugin, AgentTool } from "@yesimbot/agent-runtime";
import { authorizeToolCapability, builtinToolCapability, toolCapabilitySchema, type ToolCapabilityScope } from "@yesimbot/contracts";
import { AppError } from "@yesimbot/foundation";

import { ADMIN_ONLY_REASON } from "./admins.js";
import { TOOL_ERRORS } from "./errors.js";

/** Built-in declarations are authoritative; extension tools need a complete explicit declaration. */
export function declareBuiltinTools(tools: readonly AgentTool[], pluginId: string, currentPlatform?: string): AgentTool[] {
  return tools.map((tool) => {
    const capability = builtinToolCapability(pluginId, tool.name, currentPlatform) ?? tool.capability;
    const parsed = toolCapabilitySchema.safeParse(capability);
    return { ...tool, ...(parsed.success ? { capability: parsed.data, executionKind: parsed.data.executionKind } : { capability: undefined }) };
  });
}

/**
 * Core-owned final boundary, applied after all plugin filters and again at execution. Every conversation is offered
 * every tool of its platform; a sensitive one runs only when `admin` says the people behind the call are admins.
 * Without `admin` nobody is (fails closed).
 */
export function capabilityBoundary(
  scope: ToolCapabilityScope,
  admin: (messages: readonly AgentMessage[]) => boolean = () => false,
): Pick<AgentPlugin, "filterTools" | "beforeToolCall"> {
  const conversation = Object.freeze({ platform: scope.platform, kind: scope.kind });
  const toolsByName = new Map<string, AgentTool>();
  const allowed = (tool: AgentTool) => authorizeToolCapability({ conversation }, tool.capability).allowed;
  const adminOnly = (tool: AgentTool, messages: readonly AgentMessage[] | undefined) => {
    if (!tool.capability?.sensitive) return false;
    try {
      return !admin(messages ?? []);
    } catch {
      return true;
    }
  };
  return {
    filterTools: (tools) => {
      toolsByName.clear();
      return tools.filter(allowed).map((tool) => {
        toolsByName.set(tool.name, tool);
        return typeof tool.execute !== "function"
          ? tool
          : {
              ...tool,
              execute(input, context) {
                if (!allowed(tool)) throw new AppError(TOOL_ERRORS.tool_capability_denied, { effect: "none" });
                if (adminOnly(tool, context?.messages)) throw new AppError(TOOL_ERRORS.tool_admin_only, { effect: "none" });
                return tool.execute(input, context);
              },
            };
      });
    },
    beforeToolCall: (call, context) => {
      const tool = toolsByName.get(call.toolName);
      if (!tool || !allowed(tool)) return { type: "block", reason: "工具未声明或当前平台不适配", retry: false };
      return adminOnly(tool, context?.messages) ? { type: "block", reason: ADMIN_ONLY_REASON, retry: false } : { type: "allow" };
    },
  };
}
