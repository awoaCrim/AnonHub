import type { AgentTool } from "@yesimbot/agent-runtime";
import { builtinToolCapability } from "@yesimbot/contracts";
import { expect, it } from "vitest";

import { runtimeToolBoundary } from "../src/tasks/tool-execution.js";

const tool = (plugin: string, name: string): AgentTool => ({
  name,
  description: "original description",
  capability: builtinToolCapability(plugin, name, "onebot"),
  inputSchema: {} as never,
  execute: async () => ({ ok: true }),
});
const context = {} as never;

it("lets the main agent use admitted content tools directly and still advertises them for delegation", async () => {
  const tools = [tool("core", "task_create"), tool("yesimbot-workspace", "render_html"), tool("yesimbot-search-service", "search_web")];
  const boundary = runtimeToolBoundary({ platform: "onebot", kind: "group" }, "main");
  const main = (await boundary.filterTools!(tools, context))!;
  expect(main.map((item) => item.name)).toEqual(["task_create", "render_html", "search_web"]);
  expect(main[0]!.description).toContain("content: render_html");
  expect(main[0]!.description).toContain("service: 无可用执行工具");
  expect(main[0]!.description).not.toContain("search_web");
  expect((await boundary.beforeToolCall!({ toolName: "render_html" } as never, context))?.type).toBe("allow");
  const worker = (await runtimeToolBoundary({ platform: "onebot", kind: "group" }, "content").filterTools!(tools, context))!;
  expect(worker.map((item) => item.name)).toEqual(["render_html", "search_web"]);
});

it("offers sensitive group tools to the main agent but never unregistered tools, and refuses a non-admin's call", async () => {
  const tools = [tool("core", "task_create"), tool("yesimbot-workspace", "bash"), tool("yesimbot-workspace", "computer_exec"), tool("unknown", "foreign")];
  const group = { platform: "onebot", kind: "group" as const };
  const turn = (userId: string) => ({ messages: [{ role: "custom", type: "yesimbot.message", data: { user: { id: userId } } }] }) as never;
  const boundary = runtimeToolBoundary(group, "main", [], (messages) =>
    messages.some((m) => (m as never as { data: { user: { id: string } } }).data.user.id === "admin"),
  );
  const main = (await boundary.filterTools!(tools, context))!;
  expect(main.map((item) => item.name)).toEqual(["task_create", "bash", "computer_exec"]);
  expect(main[0]!.description).not.toContain("foreign");
  expect(main[0]!.description).toContain("content: bash");
  expect(main[0]!.description).toContain("computer: bash, computer_exec");
  expect(tools[0]!.description).toBe("original description");
  expect(await boundary.beforeToolCall!({ toolName: "bash" } as never, turn("someone"))).toMatchObject({ type: "block", retry: false });
  expect(() => main[1]!.execute({}, turn("someone"))).toThrow("tool_admin_only");
  expect((await boundary.beforeToolCall!({ toolName: "bash" } as never, turn("admin")))?.type).toBe("allow");
  await expect(main[1]!.execute({}, turn("admin"))).resolves.toEqual({ ok: true });
  // Without an admin check nobody is an admin.
  const closed = runtimeToolBoundary(group, "main");
  await closed.filterTools!(tools, context);
  expect(await closed.beforeToolCall!({ toolName: "bash" } as never, turn("admin"))).toMatchObject({ type: "block" });
});

it("updates the delegation summary when the admitted tool catalog changes without accumulating copies", async () => {
  const boundary = runtimeToolBoundary({ platform: "onebot", kind: "group" }, "main");
  const initial = (await boundary.filterTools!([tool("core", "task_create"), tool("yesimbot-workspace", "render_html")], context))!;
  const later = (await boundary.filterTools!(initial, context))!;
  expect(later[0]!.description?.match(/当前会话可委派/g)).toHaveLength(1);
  expect(later[0]!.description?.match(/content: render_html/g)).toHaveLength(1);
});

// User, 2026-11-19: 「按任务类型给工具」, after background tasks were seen carrying stickers, memory and mail tools.
it("gives each kind of background task its own tools, and tells the main agent which reading is whose", async () => {
  const tools = [
    tool("core", "task_create"),
    tool("core", "read"),
    tool("yesimbot-workspace", "readFile"),
    tool("yesimbot-workspace", "bash"),
    tool("yesimbot-workspace", "computer_exec"),
    tool("yesimbot-search-service", "search_web"),
    tool("yesimbot-image-tools", "generate_image"),
    tool("yesimbot-google", "gmail"),
    tool("yesimbot-google", "gmail_send"),
    tool("yesimbot-schedule", "schedule_list"),
    tool("yesimbot-schedule", "schedule_create"),
    tool("yesimbot-xiaoheihe", "xiaoheihe"),
    tool("yesimbot-onebot-utils", "onebot_ocr_image"),
    tool("yesimbot-sticker-manager", "sticker_search"),
    tool("yesimbot-sticker-manager", "sticker_steal"),
    tool("yesimbot-memorizer", "recall"),
    tool("yesimbot-memorizer", "remember"),
  ];
  const scope = { platform: "onebot", kind: "direct" as const };
  const names = async (role: "computer" | "content" | "service") =>
    ((await runtimeToolBoundary(scope, role, ["task_report"]).filterTools!(tools, context)) ?? []).map((item) => item.name);
  expect(await names("computer")).toEqual(["read", "readFile", "bash", "computer_exec", "search_web"]);
  expect(await names("content")).toEqual(["read", "readFile", "bash", "search_web", "generate_image", "gmail", "xiaoheihe", "onebot_ocr_image"]);
  expect(await names("service")).toEqual(["read", "readFile", "search_web", "gmail", "gmail_send", "schedule_list", "schedule_create", "xiaoheihe"]);
  // The main agent keeps every tool, and learns which kind of task can read what; reading every task has goes unlisted.
  const main = (await runtimeToolBoundary(scope, "main").filterTools!(tools, context))!;
  expect(main).toHaveLength(tools.length);
  const summary = main.find((item) => item.name === "task_create")!.description!;
  expect(summary).toContain("computer: bash, computer_exec");
  expect(summary).toContain("content: bash, generate_image, gmail, onebot_ocr_image, xiaoheihe");
  expect(summary).toContain("service: gmail, gmail_send, schedule_create, schedule_list, xiaoheihe");
  for (const hidden of ["readFile", "search_web", "sticker_search", "sticker_steal", "recall", "remember"])
    expect(summary).not.toMatch(new RegExp(`\\b${hidden}\\b`));
});
