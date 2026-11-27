import { jsonSchema, type AgentTool } from "@yesimbot/agent-runtime";
import type { ToolCapability } from "@yesimbot/contracts";
import { expect, it, vi } from "vitest";

import { protectPluginTools } from "../src/tool-policy.js";
const group = { platform: "onebot", kind: "group" as const };
const direct = { platform: "web", kind: "direct" as const };
const execution = { turnId: "turn", messages: [] } as never;
const capability: ToolCapability = { platforms: ["web", "onebot"], sensitive: false, executionKind: "read" };
const makeTool = (name: string, declaration: ToolCapability | null = capability): AgentTool => ({
  name,
  capability: declaration ?? undefined,
  inputSchema: jsonSchema({ type: "object" }),
  execute: vi.fn(async () => "effect"),
});

it("allows a tool by its declaration", async () => {
  const tool = makeTool("declared_read");
  const plugin = protectPluginTools({ name: "fixture", tools: [tool] }, group, "fixture");
  const tools = plugin.tools as AgentTool[];
  expect(tools.map((entry) => entry.name)).toEqual(["declared_read"]);
  expect(await plugin.beforeToolCall!({ toolName: tool.name } as never, execution)).toEqual({ type: "allow" });
  await expect(tools[0].execute({}, execution)).resolves.toBe("effect");
});

it("never infers unknown extension safety or platform adaptation from a tool's name", () => {
  const plugin = protectPluginTools({ name: "unknown", tools: [makeTool("readFile", null), makeTool("unknown", null)] }, direct, "third-party");
  expect(plugin.tools).toEqual([]);
});

it("offers sensitive tools and their guidance in groups; the call is admin-gated by the central boundary, not by the plugin filter", async () => {
  const original = makeTool("private_tool", { ...capability, sensitive: true });
  const plugin = protectPluginTools({ name: "fixture", tools: [original], appendSystemPrompt: () => "private guide" }, group, "fixture");
  expect((plugin.tools as AgentTool[]).map((entry) => entry.name)).toEqual(["private_tool"]);
  expect(await plugin.appendSystemPrompt!({} as never)).toBe("private guide");
  expect(await plugin.beforeToolCall!({ toolName: original.name } as never, execution)).toEqual({ type: "allow" });
  // A platform the tool does not declare is still refused.
  const elsewhere = protectPluginTools({ name: "fixture", tools: [original] }, { platform: "telegram", kind: "group" }, "fixture");
  expect(elsewhere.tools).toEqual([]);
});

it("does not let web's baseline override platform-only native tools", () => {
  const plugin = protectPluginTools({ name: "qq", tools: [makeTool("onebot_create_reaction")] }, direct, "yesimbot-onebot-utils");
  expect(plugin.tools).toEqual([]);
});

it("injects authoritative declarations into centrally registered built-in tools", () => {
  const tool = makeTool("gmail", { ...capability, sensitive: false });
  const inGroup = protectPluginTools({ name: "google", tools: [tool] }, group, "yesimbot-google").tools as AgentTool[];
  expect(inGroup[0].capability).toMatchObject({ sensitive: true, executionKind: "read" });
  const tools = protectPluginTools({ name: "google", tools: [tool] }, direct, "yesimbot-google").tools as AgentTool[];
  expect(tools[0].capability).toMatchObject({ sensitive: true, executionKind: "read" });
});

it("guards dynamic replacements while preserving unrelated tools and confirmation hooks", async () => {
  const original = makeTool("declared"),
    replacement = makeTool("declared"),
    unrelated = makeTool("other");
  const plugin = protectPluginTools(
    {
      name: "fixture",
      tools: [original],
      extendTools: () => [unrelated, replacement, makeTool("undeclared", null)],
      beforeToolCall: () => ({ type: "block", reason: "confirmation_required" }),
    },
    direct,
    "fixture",
  );
  const extended = await plugin.extendTools!([unrelated, ...(plugin.tools as AgentTool[])], {} as never);
  expect(extended!.map((tool) => tool.name)).toEqual(["other", "declared"]);
  await expect(extended![1].execute({}, execution)).resolves.toBe("effect");
  expect(replacement.execute).toHaveBeenCalledOnce();
  expect(original.execute).not.toHaveBeenCalled();
  expect(await plugin.beforeToolCall!({ toolName: "declared" } as never, execution)).toEqual({ type: "block", reason: "confirmation_required" });
});

it("retains prompt-only plugins", async () => {
  const plugin = protectPluginTools({ name: "role", appendSystemPrompt: () => "role" }, direct, "role");
  expect(await plugin.appendSystemPrompt!({} as never)).toBe("role");
});
