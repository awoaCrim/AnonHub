import type { AgentPlugin, AgentTool } from "@yesimbot/agent-runtime";
import { describe, expect, it, vi } from "vitest";

import { protectPluginTools, unavailableBuiltinTools, withoutUnavailableTools } from "../src/tool-policy.js";
// User, 2026-11-18: 「qq那边存在不能使用工具但系统提示词里面残留了提示词的情况」 and 「想知道各个平台都有哪些工具很费劲」.
describe("one table decides which tools a conversation has, and prompts follow it", () => {
  it("lists what a QQ group and a QQ private chat cannot use (sensitive tools are no longer in the list)", () => {
    const group = unavailableBuiltinTools({ platform: "onebot", kind: "group" });
    expect(group).toEqual(expect.arrayContaining(["relay_to_conversation", "instance_memory_read"]));
    for (const usable of [
      "send_message",
      "finish",
      "recall",
      "remember",
      "schedule_create",
      "sticker_send",
      "onebot_set_essence",
      "onebot_group_admin",
      "web_search",
      "xiaoheihe",
      // Sensitive tools are offered in groups; only their call is admin-gated.
      "computer_browser",
      "readFile",
      "bash",
      "gmail",
      "list_conversations",
      "xiaoheihe_publish",
    ])
      expect(group).not.toContain(usable);
    const direct = unavailableBuiltinTools({ platform: "onebot", kind: "direct" });
    expect(direct).toEqual(expect.arrayContaining(["instance_memory_read", "onebot_group_admin", "onebot_set_essence"]));
    for (const usable of ["computer_browser", "readFile", "gmail", "onebot_set_qq_profile", "xiaoheihe", "xiaoheihe_publish"])
      expect(direct).not.toContain(usable);
  });

  it("drops a list item or sentence that names an unavailable tool, and nothing else", () => {
    const text = [
      "## 工具",
      "- **computer_browser**：操作浏览器。",
      "- **recall**：读取记忆。",
      "先用 recall 找背景。需要看网页时用 computer_browser 打开；用完关掉。不要猜。",
    ].join("\n");
    expect(withoutUnavailableTools(text, ["computer_browser"])).toEqual({
      value: ["## 工具", "- **recall**：读取记忆。", "先用 recall 找背景。用完关掉。不要猜。"].join("\n"),
      removed: ["computer_browser"],
    });
    // A tool name inside a longer word is not a mention.
    expect(withoutUnavailableTools("用 git_status 看看。", ["git"]).removed).toEqual([]);
    expect(withoutUnavailableTools(["只讲 bash。", "留下这句。"], ["bash"])).toEqual({ value: ["留下这句。"], removed: ["bash"] });
    expect(withoutUnavailableTools("只讲 bash。", ["bash"]).value).toBeUndefined();
  });

  it("prunes a plugin's prompt in a group and reports what it had to remove", async () => {
    const tool = (name: string): AgentTool => ({ name, description: name, inputSchema: { type: "object" } as never, execute: vi.fn() });
    const plugin: AgentPlugin = {
      name: "workspace",
      tools: [tool("readFile"), tool("render_html")],
      appendSystemPrompt: () => "用 readFile 读文件。用 render_html 渲染网页。也可以用 instance_memory_read 看实例记忆。",
    };
    const removed = vi.fn();
    const protectedPlugin = protectPluginTools(plugin, { platform: "onebot", kind: "group" }, "yesimbot-workspace", removed);
    const tools = (await (typeof protectedPlugin.tools === "function" ? protectedPlugin.tools({} as never) : protectedPlugin.tools)) ?? [];
    expect(tools.map((item) => item.name)).toEqual(["readFile", "render_html"]);
    expect(await protectedPlugin.appendSystemPrompt?.({} as never)).toBe("用 readFile 读文件。用 render_html 渲染网页。");
    expect(removed).toHaveBeenCalledWith(["instance_memory_read"]);
    // A private chat prunes the same unavailable tool; the sensitive readFile stays in both.
    const direct = protectPluginTools(plugin, { platform: "onebot", kind: "direct" }, "yesimbot-workspace");
    await (typeof direct.tools === "function" ? direct.tools({} as never) : direct.tools);
    expect(await direct.appendSystemPrompt?.({} as never)).toBe("用 readFile 读文件。用 render_html 渲染网页。");
  });

  it("also prunes a plugin that brings no tools of its own", async () => {
    const plugin: AgentPlugin = {
      name: "notes",
      appendSystemPrompt: () => "需要时用 instance_memory_read 查实例记忆。需要时用 gmail 查邮件。平时正常聊天。",
    };
    expect(await protectPluginTools(plugin, { platform: "onebot", kind: "group" }, "notes").appendSystemPrompt?.({} as never)).toBe(
      "需要时用 gmail 查邮件。平时正常聊天。",
    );
  });
});

// User, 2026-11-19: 「按任务类型给工具」: a task's prompt says nothing about chat or about other tasks' tools.
describe("a background task gets its own kind's tools, and its prompt follows them", () => {
  const tool = (name: string): AgentTool => ({ name, description: name, inputSchema: { type: "object" } as never, execute: vi.fn() });
  const names = async (plugin: AgentPlugin) =>
    ((await (typeof plugin.tools === "function" ? plugin.tools({} as never) : plugin.tools)) ?? []).map((item) => item.name);
  const direct = { platform: "onebot", kind: "direct" as const };

  it("lists, per kind of task, the built-in tools its prompt may not mention", () => {
    const computer = unavailableBuiltinTools(direct, "computer");
    expect(computer).toEqual(
      expect.arrayContaining(["send_message", "sticker_search", "recall", "remember", "gmail", "xiaoheihe", "generate_image", "render_html", "schedule_list"]),
    );
    for (const usable of ["read", "readFile", "bash", "computer_exec", "search_web"]) expect(computer).not.toContain(usable);
    const content = unavailableBuiltinTools(direct, "content");
    expect(content).toEqual(expect.arrayContaining(["computer_exec", "schedule_list", "gmail_send", "sticker_search", "recall"]));
    for (const usable of ["gmail", "xiaoheihe", "onebot_get_forward_message", "generate_image", "render_html", "bash"]) expect(content).not.toContain(usable);
    const service = unavailableBuiltinTools(direct, "service");
    expect(service).toEqual(expect.arrayContaining(["bash", "generate_image", "onebot_get_forward_message", "remember", "sticker_steal"]));
    for (const usable of ["gmail", "gmail_send", "schedule_list", "schedule_create", "xiaoheihe_publish", "readFile"]) expect(service).not.toContain(usable);
    // The main conversation is not narrowed.
    expect(unavailableBuiltinTools(direct, "main")).toEqual(unavailableBuiltinTools(direct));
  });

  it("drops a chat plugin, its tools and its prompt, from every task", async () => {
    const stickers: AgentPlugin = {
      name: "stickers",
      tools: [tool("sticker_search"), tool("sticker_send")],
      appendSystemPrompt: () => "表情包可按当前语境自主选用；需要时用 sticker_search 查询。发送使用 sticker_send。",
    };
    for (const role of ["computer", "content", "service"] as const) {
      const plugin = protectPluginTools(stickers, direct, "yesimbot-sticker-manager", undefined, role);
      expect(await names(plugin)).toEqual([]);
      expect(await plugin.appendSystemPrompt?.({} as never)).toBeUndefined();
    }
    const main = protectPluginTools(stickers, direct, "yesimbot-sticker-manager", undefined, "main");
    expect(await names(main)).toEqual(["sticker_search", "sticker_send"]);
    expect(await main.appendSystemPrompt?.({} as never)).toContain("sticker_send");
  });

  it("keeps the tools a task's kind may use and only the sentences about them", async () => {
    const workspace: AgentPlugin = {
      name: "workspace",
      tools: [tool("readFile"), tool("bash"), tool("render_html"), tool("computer_exec")],
      appendSystemPrompt: () => "用 readFile 读文件。用 bash 跑命令。用 render_html 渲染网页。用 computer_exec 在电脑上跑命令。",
    };
    const run = async (role: "computer" | "content" | "service") => {
      const removed = vi.fn();
      const plugin = protectPluginTools(workspace, direct, "yesimbot-workspace", removed, role);
      return { tools: await names(plugin), prompt: await plugin.appendSystemPrompt?.({} as never) };
    };
    expect(await run("computer")).toEqual({
      tools: ["readFile", "bash", "computer_exec"],
      prompt: "用 readFile 读文件。用 bash 跑命令。用 computer_exec 在电脑上跑命令。",
    });
    expect(await run("content")).toEqual({
      tools: ["readFile", "bash", "render_html"],
      prompt: "用 readFile 读文件。用 bash 跑命令。用 render_html 渲染网页。",
    });
    expect(await run("service")).toEqual({ tools: ["readFile"], prompt: "用 readFile 读文件。" });
  });
});
