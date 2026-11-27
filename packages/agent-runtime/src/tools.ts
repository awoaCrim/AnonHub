import { asSchema, jsonSchema, type FlexibleSchema, type Tool, type ToolExecutionOptions, type ToolSet } from "ai";
import Ajv, { type ValidateFunction } from "ajv";

import type { AgentChannel } from "./channel.js";
import type { AgentEntry } from "./entry.js";
import { ToolConflictError } from "./errors.js";
import type { AgentMessage } from "./message.js";
import type { AgentPlugin, ToolCallContext, ToolHookContext, ToolResultContext } from "./plugin.js";
import type { AgentStateManager } from "./state.js";
import type { AgentStorage } from "./storage.js";
const inputValidator = new Ajv({ strict: false, validateFormats: false });
const compiledInputSchemas = new WeakMap<object, ValidateFunction | undefined>();

// eslint-disable-next-line typescript/no-explicit-any
export type AgentTool<IN = any, OUT = any> = Omit<Tool<IN, OUT>, "execute"> & {
  name: string;
  /** Execution capability, independent from conversation authorization. Unknown tools are worker-only. */
  executionKind?: "communication" | "read" | "computer" | "content" | "service";
  /** Explicit extension/built-in declaration. Missing declarations never gain conversation access. */
  capability?: {
    readonly platforms: readonly string[];
    readonly sensitive: boolean;
    readonly executionKind: "communication" | "read" | "computer" | "content" | "service";
    readonly contexts?: readonly ("direct" | "group")[];
    /** Background task kinds that may use the tool; absent, its execution kind decides. */
    readonly workers?: readonly ("computer" | "content" | "service")[];
  };
  /**
   * Marks a successfully executed tool as able to end the current turn. A predicate may also
   * require an accepted result; thrown errors, blocked calls, and journal notices never qualify.
   * A turn stops only when every tool call in the final step is terminal.
   */
  terminal?: boolean | ((input: IN, output: OUT) => boolean);
  execute: (input: IN, options: AgentToolExecuteContext) => Promise<OUT> | OUT;
};

export type AgentToolSet = AgentTool[];

export type ToolDecision = { type: "allow" } | { type: "block"; reason: string; retry?: boolean } | { type: "replace"; args: unknown };

export interface AgentToolExecuteContext extends Omit<ToolExecutionOptions, "messages"> {
  readonly runtime: { id: string };
  readonly channel: AgentChannel;
  readonly state: AgentStateManager;
  readonly storage: AgentStorage<AgentEntry>;
  readonly turnId: string;
  readonly messages: readonly AgentMessage[];
  /** Invoke another currently available tool through its schema and all host authorization hooks. */
  readonly invokeTool: (name: string, args: unknown) => Promise<unknown>;
}

export function mergeTools(toolSets: readonly AgentToolSet[]): AgentToolSet {
  const merged: AgentToolSet = [];
  const seen = new Set<string>();

  for (const tools of toolSets) {
    for (const tool of tools) {
      if (seen.has(tool.name)) {
        throw new ToolConflictError(tool.name);
      }
      seen.add(tool.name);
      merged.push({ ...tool });
    }
  }

  return merged;
}

export async function runBeforeToolHooks(plugins: readonly AgentPlugin[], call: ToolCallContext, context: ToolHookContext): Promise<ToolDecision> {
  let current = call;
  let currentDecision: ToolDecision = { type: "allow" };

  for (const plugin of plugins) {
    const decision = await plugin?.beforeToolCall?.(current, context);
    if (!decision || decision.type === "allow") {
      continue;
    }

    if (decision.type === "block") {
      return decision;
    }

    current = { ...current, args: decision.args };
    currentDecision = decision;
  }

  return currentDecision;
}

export async function runAfterToolHooks(plugins: readonly AgentPlugin[], result: ToolResultContext, context: ToolHookContext): Promise<ToolResultContext> {
  let current = result;

  for (const plugin of plugins) {
    const patch = await plugin?.afterToolCall?.(current, context);
    if (patch) {
      current = { ...current, ...patch };
    }
  }

  return current;
}

export function toAiToolSet(tools: AgentToolSet): ToolSet {
  const result: ToolSet = {};
  for (const tool of tools) {
    if (tool.name in result) {
      throw new ToolConflictError(tool.name);
    }

    const { name: _name, ...aiTool } = tool;
    result[tool.name] = { ...aiTool, inputSchema: validatedInputSchema(tool.inputSchema) } as unknown as Tool;
  }
  return result;
}

/**
 * A bare `jsonSchema()` carries no validator, and AI SDK then hands the model's input to `execute` unchecked. Such
 * schemas get one from their own JSON Schema, so a call that breaks it is refused as an invalid call (the model sees
 * why and can retry) instead of reaching the tool. A schema that cannot be compiled stays unchecked, as before.
 */
function validatedInputSchema(inputSchema: FlexibleSchema<unknown>): FlexibleSchema<unknown> {
  const schema = asSchema(inputSchema);
  if (schema.validate) return inputSchema;
  return jsonSchema(() => schema.jsonSchema, {
    validate: async (value) => {
      const check = await compiledInputSchema(schema.jsonSchema);
      if (!check || check(value)) return { success: true, value };
      return { success: false, error: new Error(`参数不符合工具定义：${inputValidator.errorsText(check.errors, { dataVar: "input" })}`) };
    },
  });
}

export async function compiledInputSchema(definition: ReturnType<typeof asSchema>["jsonSchema"]): Promise<ValidateFunction | undefined> {
  const resolved = await definition;
  if (typeof resolved !== "object" || resolved === null) return undefined;
  if (!compiledInputSchemas.has(resolved)) {
    let check: ValidateFunction | undefined;
    try {
      check = inputValidator.compile(resolved);
    } catch {
      check = undefined;
    }
    compiledInputSchemas.set(resolved, check);
  }
  return compiledInputSchemas.get(resolved);
}
