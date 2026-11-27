import { EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import { describe, expect, it, vi } from "vitest";

import { ComputerActivity } from "../../../core/src/computer-activity.js";
import { compactPage } from "../src/browser-page.js";
import { createWorkspaceComputerTools } from "../src/computer.js";

// Pipeline audit, 2026-11-20: whole pages (median 49 KB) went over the 24 KiB output budget, refs sat past the cut,
// tasks paged with read_tool_output (162 of 193 reads) and clicked by pixel.
const BUDGET = 24 * 1024;

function page(overrides: Record<string, unknown> = {}) {
  return {
    snapshot: "snap-1",
    targetId: "tab1",
    loaderId: "loader",
    url: "https://app.rainyun.com/apps/rcs/list",
    title: "云服务器 - 雨云",
    readyState: "complete",
    text: "雨云控制台正文".repeat(24000 / 7).slice(0, 24000),
    elements: Array.from({ length: 300 }, (_, index) => ({
      ref: `e${index}`,
      tag: index % 3 ? "A" : "BUTTON",
      role: null,
      name: `菜单项 ${index}`,
      type: null,
      disabled: index === 7,
      ...(index === 4 ? { value: "root" } : {}),
    })),
    frames: [],
    ...overrides,
  };
}

let call = 0;
const ctx = (turnId = "turn-1") =>
  ({ runtime: { id: "runtime-1" }, toolCallId: `call-${++call}`, turnId, messages: [], abortSignal: new AbortController().signal }) as never;

function browser() {
  const invoke = vi.fn();
  const tools = createWorkspaceComputerTools(
    { invoke, activity: new ComputerActivity() } as never,
    { platform: "onebot", channelId: "private:test", type: "direct" } as never,
    { deviceId: "test" },
    new EphemeralImageProjectionStore(),
    (name) => name === "computer_browser",
    () => "openai:gpt-5.2",
    { mode: "native" },
  );
  const tool = tools.find((item) => item.name === "computer_browser")!;
  const sent = (index = -1) => (invoke.mock.calls.at(index)![1] as { input: Record<string, unknown> }).input;
  return { invoke, tool, sent };
}

describe("compact browser pages", () => {
  it("puts every ref of a full page first, one line each, within the output budget", () => {
    const compact = compactPage(page());
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(BUDGET);
    expect(Object.keys(compact).indexOf("elements")).toBeLessThan(Object.keys(compact).indexOf("text"));
    const lines = String(compact.elements).split("\n");
    expect(lines).toHaveLength(300);
    expect(lines[0]).toBe("e0 button 菜单项 0");
    expect(lines[299]).toBe("e299 a 菜单项 299");
    expect(lines[4]).toBe("e4 a 菜单项 4 值:root");
    expect(lines[7]).toBe("e7 a 菜单项 7 [不可用]");
    expect(compact).not.toHaveProperty("loaderId");
    expect(compact).not.toHaveProperty("frames");
    expect(compact.moreText).toMatch(/^正文还有 \d+ 字没显示：inspect 带 textOffset: \d+ 查看$/);
  });

  it("lists elements past its share by offset, never cutting a line", () => {
    const long = page({ elements: page().elements.map((element) => ({ ...element, name: "很长的名字".repeat(20) })) });
    const first = compactPage(long);
    const shown = String(first.elements).split("\n").length;
    expect(shown).toBeLessThan(300);
    expect(first.moreElements).toBe(`还有 ${300 - shown} 个元素没列出：inspect 带 elementOffset: ${shown} 查看`);
    const next = compactPage(long, 0, shown);
    expect(String(next.elements).split("\n")[0]).toMatch(new RegExp(`^e${shown} `));
    expect(next.elementRange).toMatch(new RegExp(`^${shown}–`));
  });
});

it("folds runs of unnamed icons into one line, keeping every form field and short run", () => {
  const element = (ref: number, tag: string, name = "", extra: Record<string, unknown> = {}) => ({
    ref: `e${ref}`,
    tag,
    role: null,
    name,
    type: null,
    disabled: false,
    ...extra,
  });
  const compact = compactPage(
    page({
      elements: [
        element(0, "A", "首页"),
        ...[1, 2, 3, 4, 5].map((ref) => element(ref, "A")),
        element(6, "BUTTON", "登录"),
        element(7, "BUTTON"),
        element(8, "BUTTON"),
        element(9, "INPUT", "", { type: "text" }),
        element(10, "INPUT", "", { type: "text" }),
        element(11, "INPUT", "", { type: "text" }),
      ],
    }),
  );
  expect(String(compact.elements).split("\n")).toEqual([
    "e0 a 首页",
    "e1–e5 a ×5（无名称）",
    "e6 button 登录",
    "e7 button",
    "e8 button",
    "e9 input[text]",
    "e10 input[text]",
    "e11 input[text]",
  ]);
  expect(compact).not.toHaveProperty("moreElements");
});

describe("computer_browser pages", () => {
  it("reads further into the body by offset, which the device never sees", async () => {
    const { invoke, tool, sent } = browser();
    invoke.mockResolvedValue({ status: "succeeded", output: page() });
    const first = (await tool.execute({ action: "inspect", targetId: "tab1" }, ctx())) as { output: Record<string, unknown> };
    const next = Number(/textOffset: (\d+)/.exec(String(first.output.moreText))![1]);
    expect(String(first.output.text).length).toBe(next);
    const second = (await tool.execute({ action: "inspect", targetId: "tab1", textOffset: next }, ctx())) as { output: Record<string, unknown> };
    expect(sent()).toEqual({ action: "inspect", targetId: "tab1" });
    expect(second.output.text).toBe(page().text.slice(next, next * 2));
    expect(second.output.textRange).toBe(`${next}–${next * 2}/${page().text.length}`);
  });

  it("answers a page this turn already returned as unchanged, and in full on a later turn", async () => {
    const { invoke, tool } = browser();
    invoke.mockResolvedValue({ status: "succeeded", output: page() });
    await tool.execute({ action: "inspect", targetId: "tab1" }, ctx("turn-a"));
    // PageDown returned the very same 10 KB page each time (preview task 416a5ead).
    invoke.mockResolvedValueOnce({ status: "succeeded", output: { action: "press", completed: true, page: page({ snapshot: "snap-2" }) } });
    const pressed = (await tool.execute({ action: "press", targetId: "tab1", key: "PageDown" }, ctx("turn-a"))) as {
      output: { page: Record<string, unknown> };
    };
    expect(pressed.output.page).toMatchObject({ snapshot: "snap-2", unchanged: true });
    expect(pressed.output.page).not.toHaveProperty("elements");
    expect(Buffer.byteLength(JSON.stringify(pressed))).toBeLessThan(1024);
    const later = (await tool.execute({ action: "inspect", targetId: "tab1" }, ctx("turn-b"))) as { output: Record<string, unknown> };
    expect(later.output).toHaveProperty("elements");
  });

  it("returns the current page with a stale ref refusal, so the next call has fresh refs", async () => {
    const { invoke, tool, sent } = browser();
    invoke.mockResolvedValueOnce({ status: "rejected", code: "stale_browser_snapshot" }).mockResolvedValueOnce({ status: "succeeded", output: page() });
    const refused = (await tool.execute({ action: "click", targetId: "tab1", ref: "e14" }, ctx())) as Record<string, unknown>;
    expect(sent()).toEqual({ action: "inspect", targetId: "tab1" });
    expect(refused).toMatchObject({ status: "rejected", code: "stale_browser_snapshot", message: expect.stringContaining("下面的 page 是刚读取的最新页面") });
    expect(String((refused.page as Record<string, unknown>).elements)).toContain("e14 a 菜单项 14");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("ignores a snapshot given to an action that takes none", async () => {
    const { invoke, tool, sent } = browser();
    invoke.mockResolvedValue({ status: "succeeded", output: page() });
    expect(await tool.execute({ action: "inspect", targetId: "tab1", snapshot: "old" }, ctx())).toMatchObject({ status: "succeeded" });
    expect(sent()).toEqual({ action: "inspect", targetId: "tab1" });
    expect(await tool.execute({ action: "inspect", targetId: "tab1", textOffset: -1 }, ctx())).toMatchObject({ code: "invalid_browser_input" });
  });
});
