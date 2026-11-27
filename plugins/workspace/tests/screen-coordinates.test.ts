import { EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import { imageDimensions } from "@yesimbot/foundation";
import { describe, expect, it, vi } from "vitest";

import { ComputerActivity } from "../../../core/src/computer-activity.js";
import { guiShellProgram } from "../src/computer-shell.js";
import { computerGuidance, createWorkspaceComputerTools } from "../src/computer.js";
import { usesNormalizedCoordinates } from "../src/coordinates.js";

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(bytes);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0, 16, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0, 17, 8]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}
const shot = (width: number, height: number, text = "") => ({
  status: "succeeded",
  output: { text, data: png(width, height).toString("base64"), mediaType: "image/png" },
});

let call = 0;
const ctx = () =>
  ({ runtime: { id: "runtime-1" }, toolCallId: `call-${++call}`, turnId: "turn-1", messages: [], abortSignal: new AbortController().signal }) as never;

function setup(model: string | undefined, grants: string[] = ["computer_ui"]) {
  const invoke = vi.fn();
  const tools = createWorkspaceComputerTools(
    { invoke, activity: new ComputerActivity() } as never,
    { platform: "onebot", channelId: "private:test", type: "direct" } as never,
    { deviceId: "test" },
    new EphemeralImageProjectionStore(),
    (name) => grants.includes(name),
    () => model,
    { mode: "native" },
  );
  const tool = (name: string) => tools.find((item) => item.name === name)!;
  const sent = () => (invoke.mock.calls.at(-1)![1] as { input: unknown }).input;
  return { invoke, tool, sent };
}

describe("screen sizes and model families", () => {
  it("reads the pixel size of PNG and JPEG screenshots", () => {
    expect(imageDimensions(png(1280, 800))).toEqual({ width: 1280, height: 800 });
    expect(imageDimensions(jpeg(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(imageDimensions(Buffer.from([1, 2, 3]))).toBeUndefined();
  });

  it("treats Gemini models as giving 0–1000 grid points", () => {
    expect(usesNormalizedCoordinates("antigravity-gemini:gemini-3.8-flash-high")).toBe(true);
    expect(usesNormalizedCoordinates({ modelId: "gemini-3.8-flash-high", provider: "proxy" } as never)).toBe(true);
    expect(usesNormalizedCoordinates("openai:gpt-5.2")).toBe(false);
    expect(usesNormalizedCoordinates(undefined)).toBe(false);
  });
});

describe("agent-desktop coordinates", () => {
  it("states the screenshot size and converts a Gemini mouse point to that screenshot's pixels", async () => {
    const { invoke, tool, sent } = setup("gemini-3.8-flash-high");
    invoke.mockResolvedValueOnce(shot(1600, 1000, JSON.stringify({ ok: true, data: { width: 1600, height: 1000, scale_factor: 1.0 } })));
    const state = await tool("computer_ui").execute({ tool: "screenshot" }, ctx());
    expect((state as { screenshot: string }).screenshot).toContain("截图 1600×1000 像素");
    invoke.mockResolvedValueOnce({ status: "succeeded", output: { text: '{"ok":true}' } });
    const click = await tool("computer_ui").execute({ tool: "mouse_click", args: { xy: "500,250" } }, ctx());
    expect(sent()).toEqual({ tool: "mouse_click", args: { xy: "800,250" } });
    expect(click).toMatchObject({ coordinates: expect.stringContaining("x=800, y=250") });
    // Element actions carry refs, not points: nothing to convert.
    invoke.mockResolvedValueOnce({ status: "succeeded", output: { text: "{}" } });
    await tool("computer_ui").execute({ tool: "click", args: { ref_id: "@s1:e2" } }, ctx());
    expect(sent()).toEqual({ tool: "click", args: { ref_id: "@s1:e2" } });
  });

  it("asks for a screenshot first, and divides a scaled screenshot back to screen points", async () => {
    const blind = setup("gemini-3.8-flash-high");
    blind.invoke.mockResolvedValue({ status: "succeeded", output: { text: "{}" } });
    expect(await blind.tool("computer_ui").execute({ tool: "mouse_wheel", args: { x: 500, y: 500, dy: 3 } }, ctx())).toMatchObject({
      coordinates: expect.stringContaining("先 screenshot"),
    });
    expect(blind.sent()).toEqual({ tool: "mouse_wheel", args: { x: 500, y: 500, dy: 3 } });

    const retina = setup("openai:gpt-5.2");
    retina.invoke.mockResolvedValueOnce(shot(2880, 1800, JSON.stringify({ ok: true, data: { scale_factor: 2.0 } })));
    await retina.tool("computer_ui").execute({ tool: "screenshot" }, ctx());
    retina.invoke.mockResolvedValueOnce({ status: "succeeded", output: { text: "{}" } });
    await retina.tool("computer_ui").execute({ tool: "mouse_click", args: { xy: "1440,900" } }, ctx());
    expect(retina.sent()).toEqual({ tool: "mouse_click", args: { xy: "720,450" } });
  });

  it("leaves other models' pixels alone and says nothing", async () => {
    const { invoke, tool, sent } = setup("openai:gpt-5.2");
    invoke.mockResolvedValueOnce(shot(1280, 800));
    const state = await tool("computer_ui").execute({ tool: "screenshot" }, ctx());
    expect((state as { screenshot: string }).screenshot).toBe("截图 1280×800 像素；点击坐标用这张图的像素");
    invoke.mockResolvedValueOnce({ status: "succeeded", output: { text: "ok" } });
    const click = await tool("computer_ui").execute({ tool: "mouse_click", args: { xy: "717,393" } }, ctx());
    expect(sent()).toEqual({ tool: "mouse_click", args: { xy: "717,393" } });
    expect(click).not.toHaveProperty("coordinates");
  });

  it("converts points inside a desktop sequence once, retaining one device operation", async () => {
    const { invoke, tool, sent } = setup("gemini-3.8-flash-high");
    invoke.mockResolvedValueOnce(shot(2880, 1800, '{"scale_factor":2}'));
    await tool("computer_ui").execute({ tool: "screenshot" }, ctx());
    invoke.mockResolvedValueOnce(shot(2880, 1800, '{"completed":3}\n{"scale_factor":2}'));
    const actions = [
      { tool: "mouse_click", args: { xy: "500,250" } },
      { tool: "clipboard_set", args: { text: "输入内容" } },
      { tool: "press", args: { combo: "ctrl+v" } },
    ];
    await tool("computer_ui").execute({ tool: "sequence", args: { actions } }, ctx());
    expect(sent()).toEqual({ tool: "sequence", args: { actions: [{ tool: "mouse_click", args: { xy: "720,225" } }, ...actions.slice(1)] } });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(actions[0].args).toEqual({ xy: "500,250" });
  });
});

describe("shell screen commands", () => {
  it("finds programs that click or capture the screen, after env prefixes and in chains", () => {
    expect(guiShellProgram("DISPLAY=:99 XAUTHORITY=/run/anon-desktop/Xauthority xdotool mousemove 710 395 click 1")).toBe("xdotool");
    expect(guiShellProgram("sleep 1 && DISPLAY=:99 maim sign_popup.png")).toBe("maim");
    expect(guiShellProgram("cd /tmp; /usr/bin/scrot a.png")).toBe("scrot");
    expect(guiShellProgram("echo $(xdotool getmouselocation)")).toBe("xdotool");
    expect(guiShellProgram("timeout 5 import -window root a.png")).toBe("import");
    expect(guiShellProgram("sudo -u anon xwd -root | convert - a.png")).toBe("xwd");
    expect(guiShellProgram("ls | maim -s x.png")).toBe("maim");
  });

  it("does not flag the same words as arguments or inside quotes", () => {
    expect(guiShellProgram('python3 -c "x=1; import os"')).toBeUndefined();
    expect(guiShellProgram("echo xdotool")).toBeUndefined();
    expect(guiShellProgram("grep maim log.txt")).toBeUndefined();
    expect(guiShellProgram("cat 'a; xdotool'")).toBeUndefined();
    expect(guiShellProgram("ls -la")).toBeUndefined();
  });

  it("refuses them only while a desktop tool is offered", async () => {
    const withDesktop = setup("gemini-3.8-flash-high", ["computer_exec", "computer_ui", "computer_browser"]);
    const refused = await withDesktop.tool("computer_exec").execute({ command: "DISPLAY=:99 xdotool click 1" }, ctx());
    expect(refused).toMatchObject({ status: "rejected", code: "use_desktop_tool" });
    expect((refused as { message: string }).message).toContain("computer_ui");
    expect((refused as { message: string }).message).toContain("ref_id");
    expect(withDesktop.invoke).not.toHaveBeenCalled();

    const shellOnly = setup("gemini-3.8-flash-high", ["computer_exec"]);
    shellOnly.invoke.mockResolvedValue({ status: "succeeded", output: { exitCode: 0 } });
    await shellOnly.tool("computer_exec").execute({ command: "xdotool click 1" }, ctx());
    expect(shellOnly.invoke).toHaveBeenCalledOnce();
  });
});

describe("browser screenshots", () => {
  it("converts Gemini grid points of click_at into pixels of that tab's latest screenshot", async () => {
    const { invoke, tool, sent } = setup("gemini-3.8-flash-high", ["computer_browser"]);
    invoke.mockResolvedValue({ status: "succeeded", output: { text: "{}", data: jpeg(1280, 800).toString("base64"), mediaType: "image/jpeg" } });
    const unconverted = await tool("computer_browser").execute({ action: "click_at", targetId: "tab1", x: 500, y: 500 }, ctx());
    expect(sent()).toMatchObject({ x: 500, y: 500 });
    expect(unconverted).toMatchObject({ coordinates: expect.stringContaining("先截图再点") });
    await tool("computer_browser").execute({ action: "screenshot", targetId: "tab1" }, ctx());
    const converted = await tool("computer_browser").execute({ action: "click_at", targetId: "tab1", x: 500, y: 250 }, ctx());
    expect(sent()).toEqual({ action: "click_at", targetId: "tab1", x: 640, y: 200 });
    expect(converted).toMatchObject({ coordinates: expect.stringContaining("x=640, y=200") });
    // Another tab has its own screenshot.
    await tool("computer_browser").execute({ action: "click_at", targetId: "tab2", x: 500, y: 500 }, ctx());
    expect(sent()).toMatchObject({ targetId: "tab2", x: 500, y: 500 });
  });

  it("passes pixels through unchanged for other models", async () => {
    const { invoke, tool, sent } = setup("openai:gpt-5.2", ["computer_browser"]);
    invoke.mockResolvedValue({ status: "succeeded", output: { text: "{}", data: jpeg(1280, 800).toString("base64"), mediaType: "image/jpeg" } });
    await tool("computer_browser").execute({ action: "screenshot", targetId: "tab1" }, ctx());
    await tool("computer_browser").execute({ action: "click_at", targetId: "tab1", x: 500, y: 250 }, ctx());
    expect(sent()).toEqual({ action: "click_at", targetId: "tab1", x: 500, y: 250 });
  });
});

describe("browser refusals", () => {
  it("tells the bot what to do next when the page does not answer or the tab is gone", async () => {
    const { invoke, tool } = setup("openai:gpt-5.2", ["computer_browser"]);
    invoke.mockResolvedValueOnce({ status: "rejected", code: "browser_page_unresponsive" });
    expect(await tool("computer_browser").execute({ action: "screenshot", targetId: "tab1" }, ctx())).toMatchObject({
      code: "browser_page_unresponsive",
      message: expect.stringContaining("tabs"),
    });
    invoke.mockResolvedValueOnce({ status: "rejected", code: "browser_tab_not_found" });
    expect(await tool("computer_browser").execute({ action: "inspect", targetId: "gone" }, ctx())).toMatchObject({ message: expect.stringContaining("tabs") });

    // A device that refuses input it cannot parse answers only the code (preview records, 2026-11-19).
    invoke.mockResolvedValueOnce({ status: "rejected", code: "invalid_browser_input" });
    expect(await tool("computer_browser").execute({ action: "inspect", targetId: "tab1" }, ctx())).toMatchObject({
      code: "invalid_browser_input",
      message: expect.stringContaining("改正后重试"),
    });
  });
});

describe("guidance", () => {
  it("uses only the connected browser for web pages and keeps other windows on the desktop driver", () => {
    const ui = computerGuidance(["computer_exec", "computer_ui", "computer_browser"]);
    expect(ui).toContain("snapshot");
    expect(ui).toContain("ref_id");
    expect(ui).toContain("sequence");
    // A computer with a connected browser uses no other browser (user-confirmed 2026-11-16).
    expect(ui).toContain("computer_browser 只能操作它连接的那个浏览器");
    expect(ui).toContain("电脑连接了浏览器时只用这一个");
    expect(ui).toContain("不要启动或改用其他浏览器");
    // Browser and desktop stay apart: captchas are done in the browser tool too (user-confirmed 2026-11-16).
    expect(ui).toContain("screenshot 看、click_at 按截图像素点");
    expect(ui).toContain("不要用桌面工具操作网页");
    expect(ui).toContain("其他窗口用 computer_ui");
    expect(computerGuidance(["computer_ui"])).not.toContain("computer_browser");
    expect(computerGuidance(["computer_use"])).toContain("界面操作（看屏幕、点击、输入）用 computer_use");
    expect(computerGuidance(["computer_browser"])).toContain("动作后直接使用返回的 page 快照继续");
    expect(computerGuidance(["computer_exec"])).toBe("");
  });
});
