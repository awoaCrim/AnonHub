import type { AgentMessage, AgentPlugin, AgentTool, SystemPromptAppend, SystemPromptBlock } from "@yesimbot/agent-runtime";
import {
  authorizeToolCapability,
  builtinToolCapability,
  builtinToolDeclarations,
  type ToolCapability,
  type ToolCapabilityScope,
  type ToolDescriptor,
} from "@yesimbot/contracts";
import { AppError } from "@yesimbot/foundation";

import { executionAllowed, type ExecutionRole } from "./tasks/tool-execution.js";
import { declareBuiltinTools } from "./tools/capabilities.js";
import { TOOL_ERRORS } from "./tools/errors.js";

/** Current raw carriers only. Missing identity in any message fails the whole mixed batch closed. */
export function toolActors(messages: readonly AgentMessage[] = [], platform: string) {
  const users = new Set<string>();
  for (const message of messages) {
    if (message.role !== "custom" || message.type !== "yesimbot.message") continue;
    const user = (message.data as { user?: { id?: unknown } } | undefined)?.user?.id;
    if (typeof user !== "string" || !user) return [{ platform, userId: "" }];
    users.add(user);
  }
  return [...users].map((userId) => ({ platform, userId }));
}

/** Declarations own authorization: a tool is allowed by its context and capability. */
export function toolAllowed(conversation: ToolCapabilityScope, descriptor: ToolDescriptor): boolean {
  if (!descriptor.contexts.includes(conversation.kind)) return false;
  const capability = builtinToolCapability(descriptor.pluginId, descriptor.name, conversation.platform) ?? descriptor.capability;
  return authorizeToolCapability({ conversation }, capability).allowed;
}

export function hasAllowedTools(conversation: ToolCapabilityScope, descriptors: readonly ToolDescriptor[]): boolean {
  return descriptors.some((descriptor) => toolAllowed(conversation, descriptor));
}

export function createToolPolicyHooks(
  conversation: ToolCapabilityScope,
  descriptors: readonly ToolDescriptor[] | (() => readonly ToolDescriptor[]),
): Pick<AgentPlugin, "filterTools" | "beforeToolCall"> {
  const lookup = (name: string) => (typeof descriptors === "function" ? descriptors() : descriptors).find((tool) => tool.name === name);
  return {
    filterTools: (tools) =>
      tools.filter((tool) => {
        const descriptor = lookup(tool.name);
        return !descriptor || toolAllowed(conversation, descriptor);
      }),
    beforeToolCall: (call) => {
      const descriptor = lookup(call.toolName);
      return descriptor && !toolAllowed(conversation, descriptor)
        ? { type: "block", reason: "此工具在当前平台或群聊中不可用", retry: false }
        : { type: "allow" };
    },
  };
}

/** Direct execution is checked too, including an alias/delegate invoking a target tool. */
export function guardToolPolicy(tools: readonly AgentTool[], conversation: ToolCapabilityScope, descriptors: readonly ToolDescriptor[]): AgentTool[] {
  const byName = new Map(descriptors.map((tool) => [tool.name, tool]));
  return tools.flatMap((original) => {
    const descriptor = byName.get(original.name);
    if (!descriptor) return [];
    const [tool] = declareBuiltinTools([original], descriptor.pluginId, conversation.platform);
    const resolved = { ...descriptor, capability: tool.capability };
    const allowed = () => toolAllowed(conversation, resolved);
    if (!allowed()) return [];
    return [
      {
        ...tool,
        execute(input, execution) {
          if (!allowed()) throw new AppError(TOOL_ERRORS.tool_capability_denied, { effect: "none" });
          return tool.execute(input, execution);
        },
      },
    ];
  });
}

/** Built-in tool names no declaration lets this conversation use (from the central table). */
/** Built-in tool names no declaration lets this conversation, or this kind of background task, use. */
export function unavailableBuiltinTools(conversation: ToolCapabilityScope, role?: ExecutionRole): string[] {
  const declarations = builtinToolDeclarations(conversation.platform);
  const usable = new Set(
    declarations
      .filter(
        (item) =>
          authorizeToolCapability({ conversation }, item.capability).allowed &&
          (!role || executionAllowed({ name: item.name, capability: item.capability }, role)),
      )
      .map((item) => item.name),
  );
  return [...new Set(declarations.map((item) => item.name))].filter((name) => !usable.has(name));
}

/**
 * Drop what a prompt says about tools this conversation cannot use (user, 2026-11-18: QQ prompts still described
 * tools QQ could not call). A list item that names one goes as a whole; elsewhere the sentence that names it goes.
 */
export function withoutUnavailableTools(value: SystemPromptAppend, names: readonly string[]): { value?: SystemPromptAppend; removed: string[] } {
  if (!names.length) return { value, removed: [] };
  const pattern = new RegExp(`(?<![A-Za-z0-9_])(?:${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z0-9_])`, "g");
  const removed = new Set<string>();
  const mentions = (text: string) => {
    const found = text.match(pattern);
    found?.forEach((name) => removed.add(name));
    return !!found;
  };
  const prune = (text: string) =>
    text
      .split("\n")
      .flatMap((line) => {
        if (/^\s*(?:[-*•]|\d+[.、)])\s/.test(line)) return mentions(line) ? [] : [line];
        const kept = (line.match(/[^。；！？!?]+[。；！？!?]*|[。；！？!?]+/g) ?? [line]).filter((sentence) => !mentions(sentence)).join("");
        return kept.trim() || !line.trim() ? [kept] : [];
      })
      .join("\n")
      .trim();
  const blocks = (Array.isArray(value) ? value : [value]) as SystemPromptBlock[];
  const result = blocks
    .map((block): SystemPromptBlock | undefined => {
      if (typeof block === "string") return prune(block) || undefined;
      const content = typeof block.content === "string" ? prune(block.content) : block.content;
      return content ? { ...block, content } : undefined;
    })
    .filter((block): block is SystemPromptBlock => block !== undefined);
  return { value: result.length ? (Array.isArray(value) ? result : result[0]) : undefined, removed: [...removed] };
}

/** Protect dynamic catalogs while preserving plugin-specific confirmations and lifecycle hooks. */
export function protectPluginTools(
  plugin: AgentPlugin,
  conversation: ToolCapabilityScope,
  pluginId: string,
  onPromptPruned?: (removed: string[]) => void,
  role?: ExecutionRole,
): AgentPlugin {
  const descriptors = new Map<string, ToolDescriptor>();
  // Names this plugin offered that this conversation (or this background task) may not use, plus every built-in tool
  // it may not use. A background task keeps only its own kind's tools, and the prompt only what they are about.
  const worker = role && role !== "main" ? role : undefined;
  const unavailable = new Set(unavailableBuiltinTools(conversation, worker));
  const pruned = (value: SystemPromptAppend | void) => {
    if (value === undefined) return undefined;
    const result = withoutUnavailableTools(value, [...unavailable]);
    if (result.removed.length) onPromptPruned?.(result.removed);
    return result.value;
  };
  if (!plugin.tools && !plugin.extendTools)
    return plugin.appendSystemPrompt ? { ...plugin, appendSystemPrompt: async (context) => pruned(await plugin.appendSystemPrompt!(context)) } : plugin;
  let available: boolean | undefined;
  const protect = (tools: readonly AgentTool[] = []) => {
    for (const tool of tools) descriptors.set(tool.name, { name: tool.name, pluginId, contexts: ["direct", "group"], capability: tool.capability });
    const guarded = guardToolPolicy(tools, conversation, [...descriptors.values()]).filter((tool) => !worker || executionAllowed(tool, worker));
    available = (available ?? false) || guarded.length > 0;
    const kept = new Set(guarded.map((tool) => tool.name));
    for (const tool of tools) if (!kept.has(tool.name)) unavailable.add(tool.name);
    return guarded;
  };
  const hooks = createToolPolicyHooks(conversation, () => [...descriptors.values()]);
  return {
    ...plugin,
    ...(plugin.init ? { init: plugin.init.bind(plugin) } : {}),
    ...(plugin.onAppend ? { onAppend: plugin.onAppend.bind(plugin) } : {}),
    ...(plugin.transformEntries ? { transformEntries: plugin.transformEntries.bind(plugin) } : {}),
    ...(plugin.transformMessages ? { transformMessages: plugin.transformMessages.bind(plugin) } : {}),
    ...(plugin.toModelMessages ? { toModelMessages: plugin.toModelMessages.bind(plugin) } : {}),
    ...(plugin.afterToolCall ? { afterToolCall: plugin.afterToolCall.bind(plugin) } : {}),
    ...(plugin.onTurnFinish ? { onTurnFinish: plugin.onTurnFinish.bind(plugin) } : {}),
    ...(plugin.prepareStep ? { prepareStep: plugin.prepareStep.bind(plugin) } : {}),
    ...(plugin.stop ? { stop: plugin.stop.bind(plugin) } : {}),
    tools:
      typeof plugin.tools === "function"
        ? async (runtime) => protect((await (plugin.tools as Exclude<AgentPlugin["tools"], readonly AgentTool[] | undefined>)(runtime)) ?? [])
        : plugin.tools
          ? protect(plugin.tools)
          : undefined,
    ...(plugin.extendTools
      ? {
          extendTools: async (tools, context) => {
            const previous = new Set(tools.map((tool) => tool.name));
            const extended = (await plugin.extendTools!(tools, context)) ?? tools;
            const added = protect(extended.filter((tool) => !previous.has(tool.name) || descriptors.has(tool.name)));
            return [...extended.filter((tool) => previous.has(tool.name) && !descriptors.has(tool.name)), ...added];
          },
        }
      : {}),
    ...(plugin.appendSystemPrompt
      ? { appendSystemPrompt: async (context) => (available === false ? undefined : pruned(await plugin.appendSystemPrompt!(context))) }
      : {}),
    filterTools: async (tools, context) => hooks.filterTools!((await plugin.filterTools?.(tools, context)) ?? tools, context),
    beforeToolCall: async (call, context) => {
      if (!descriptors.has(call.toolName)) return plugin.beforeToolCall?.(call, context);
      const decision = await hooks.beforeToolCall!(call, context);
      if (decision?.type === "block") return decision;
      return (await plugin.beforeToolCall?.(call, context)) ?? decision;
    },
  };
}

export { capabilityBoundary, declareBuiltinTools } from "./tools/capabilities.js";

export type { ToolDescriptor, ToolCapability };
