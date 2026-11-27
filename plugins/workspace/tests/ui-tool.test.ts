import { EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import { afterEach, expect, it, vi } from "vitest";

import { ComputerActivity } from "../../../core/src/computer-activity.js";
import { createWorkspaceComputerTools } from "../src/computer.js";

afterEach(() => vi.useRealTimers());
it("projects agent-desktop screenshots inline and clears them before a later text-only result", async () => {
  const images = new EphemeralImageProjectionStore();
  const invoke = vi
    .fn()
    .mockResolvedValueOnce({ status: "succeeded", output: { text: "new snapshot", data: "AQID", mediaType: "image/png" } })
    .mockResolvedValueOnce({ status: "succeeded", output: { text: "windows" } });
  const tool = createWorkspaceComputerTools(
    { invoke, activity: new ComputerActivity() } as never,
    { platform: "onebot", channelId: "private:test", type: "direct" } as never,
    { deviceId: "test" },
    images,
    (name) => name === "computer_ui",
    undefined,
    { mode: "native" },
  )[0];
  const ctx = { runtime: { id: "runtime-1" }, toolCallId: "call-1", turnId: "turn-1", messages: [], abortSignal: new AbortController().signal } as never;
  const output = await tool.execute({ tool: "screenshot" } as never, ctx);
  const model = await tool.toModelOutput!({ toolCallId: "call-1", output } as never);
  expect(model).toMatchObject({ type: "content", value: [{ type: "text" }, { type: "image-data", data: "AQID", mediaType: "image/png" }] });
  expect(output).toMatchObject({ text: "new snapshot" });
  expect(invoke.mock.calls[0]![1]).toMatchObject({ capability: "computer.desktop", method: "ui", input: { tool: "screenshot", args: {} } });
  const next = await tool.execute({ tool: "list_windows" } as never, ctx);
  const nextModel = await tool.toModelOutput!({ toolCallId: "call-1", output: next } as never);
  expect((nextModel as { value: unknown[] }).value).toHaveLength(1);
  images.clearAll();
});

it.each(["AMBIGUOUS_TARGET", "STALE_REF"])("observes a %s refusal without replaying the action", async (code) => {
  const images = new EphemeralImageProjectionStore();
  const failure = JSON.stringify({ ok: false, error: { code } });
  const invoke = vi
    .fn()
    .mockResolvedValueOnce({ status: "succeeded", output: { text: failure, isError: true } })
    .mockResolvedValueOnce({ status: "succeeded", output: { text: "current desktop", data: "AQID", mediaType: "image/png" } });
  const scope = { platform: "onebot", channelId: "private:test", type: "direct" } as never;
  const tool = createWorkspaceComputerTools({ invoke, activity: new ComputerActivity() } as never, scope, { deviceId: "test" }, images, () => true, undefined, {
    mode: "native",
  }).find((tool) => tool.name === "computer_ui")!;
  const ctx = { runtime: { id: "runtime-1" }, toolCallId: "call-1", turnId: "turn-1", messages: [], abortSignal: new AbortController().signal } as never;
  const output = await tool.execute({ tool: "click", args: { ref_id: "@s1:e2" } } as never, ctx);
  expect(output).toMatchObject({ status: "succeeded", isError: true, recovery: expect.stringContaining("动作未重试"), text: expect.stringContaining(code) });
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke.mock.calls.map((call) => call[1].input.tool)).toEqual(["click", "screenshot"]);
  expect(invoke.mock.calls[1]![1]).toMatchObject({ scope, capability: "computer.desktop", method: "ui" });
  expect(invoke.mock.calls[1]![1].operationId).not.toBe(invoke.mock.calls[0]![1].operationId);
  const model = (await tool.toModelOutput!({ toolCallId: "call-1", output } as never)) as { value: unknown[] };
  expect(model.value).toHaveLength(2);
  images.clearAll();
});

it("preserves a partial sequence failure when its recovery screenshot is unavailable", async () => {
  const output = {
    text: JSON.stringify({ completed: 1, failedAt: 1, results: [{ isError: true, text: JSON.stringify({ ok: false, error: { code: "AMBIGUOUS_TARGET" } }) }] }),
    isError: true,
  };
  const invoke = vi.fn().mockResolvedValueOnce({ status: "succeeded", output }).mockRejectedValueOnce(new Error("offline"));
  const images = new EphemeralImageProjectionStore();
  const tool = createWorkspaceComputerTools(
    { invoke, activity: new ComputerActivity() } as never,
    { platform: "onebot", channelId: "private:test", type: "direct" } as never,
    { deviceId: "test" },
    images,
    (name) => name === "computer_ui",
  )[0]!;
  const ctx = { runtime: { id: "runtime-1" }, toolCallId: "call-1", turnId: "turn-1", messages: [], abortSignal: new AbortController().signal } as never;
  const result = await tool.execute({ tool: "sequence", args: { actions: [{ tool: "click", args: { ref_id: "@s1:e2" } }] } } as never, ctx);
  expect(result).toMatchObject({ status: "succeeded", output, recovery: expect.stringContaining("不要猜选同名 ref") });
  expect(invoke.mock.calls.map((call) => call[1].input.tool)).toEqual(["sequence", "screenshot"]);
  expect(images.get("call-1")).toBeUndefined();
});

it("leaves uncertain action delivery untouched", async () => {
  const invoke = vi.fn().mockResolvedValue({ status: "unknown", output: { text: "execution_interrupted", isError: true } });
  const tool = createWorkspaceComputerTools(
    { invoke, activity: new ComputerActivity() } as never,
    { platform: "onebot", channelId: "private:test", type: "direct" } as never,
    { deviceId: "test" },
    new EphemeralImageProjectionStore(),
    (name) => name === "computer_ui",
  )[0]!;
  const ctx = { runtime: { id: "runtime-1" }, toolCallId: "call-1", turnId: "turn-1", messages: [], abortSignal: new AbortController().signal } as never;
  expect(await tool.execute({ tool: "click", args: { ref_id: "@s1:e2" } } as never, ctx)).toMatchObject({ status: "unknown" });
  expect(invoke).toHaveBeenCalledTimes(1);
});

function screenshotTool(images: EphemeralImageProjectionStore, policy?: Parameters<typeof createWorkspaceComputerTools>[6]) {
  const invoke = vi.fn(async () => ({ status: "succeeded", output: { text: "device observation", data: "AQID", mediaType: "image/png" } }));
  const tool = createWorkspaceComputerTools(
    { invoke, activity: new ComputerActivity() } as never,
    { platform: "test", channelId: "channel", type: "direct" },
    { deviceId: "test" },
    images,
    (name) => name === "computer_ui",
    undefined,
    policy,
  )[0]!;
  const controller = new AbortController();
  const execution = { runtime: { id: "runtime" }, toolCallId: "screen", turnId: "turn", messages: [], abortSignal: controller.signal };
  const execute = () => tool.execute({ tool: "screenshot" }, execution as never);
  const project = (output: unknown) => tool.toModelOutput!({ toolCallId: "screen", input: { tool: "screenshot" }, output });
  return { invoke, execute, project, controller };
}

it.each([undefined, { mode: "unavailable" as const }, { mode: "native" as const, nativeMediaTypes: ["image/jpeg"] }])(
  "explicitly reports unavailable screenshot pixels without an allowed native route (%j)",
  async (policy) => {
    const images = new EphemeralImageProjectionStore();
    const fixture = screenshotTool(images, policy);
    const result = await fixture.execute();
    expect(result).toMatchObject({
      status: "succeeded",
      imageMode: "unavailable",
      error: "image_input_unavailable",
      screenshot: expect.stringContaining("没有看到"),
    });
    expect(images.get("screen")).toBeUndefined();
    const projected = await fixture.project(result);
    expect(projected).toMatchObject({ type: "content", value: [{ type: "text" }] });
    expect(JSON.stringify(projected)).not.toContain("AQID");
    expect(fixture.invoke).toHaveBeenCalledOnce();
  },
);

it.each(["ttl", "capacity", "abort", "replacement", "copied-result"])(
  "fails closed after screenshot projection %s without replaying the action",
  async (loss) => {
    vi.useFakeTimers();
    const images = new EphemeralImageProjectionStore({ ttlMs: 50, capacity: 1 });
    const fixture = screenshotTool(images, { mode: "native" });
    let result = await fixture.execute();
    expect(result).toMatchObject({ imageMode: "native" });
    if (loss === "ttl") await vi.advanceTimersByTimeAsync(51);
    if (loss === "capacity") images.stage({ toolCallId: "other", turnId: "turn", bytes: new Uint8Array([4]), mediaType: "image/png" });
    if (loss === "abort") fixture.controller.abort();
    if (loss === "replacement") {
      const replacement = await fixture.execute();
      expect(await fixture.project(replacement)).toMatchObject({ value: [{ type: "text" }, { type: "image-data" }] });
    }
    if (loss === "copied-result") result = { ...(result as object) };
    const projected = await fixture.project(result);
    expect(projected).toMatchObject({ type: "content", value: [{ type: "text" }] });
    const receipt = JSON.parse((projected as { value: [{ text: string }] }).value[0].text);
    expect(receipt).toMatchObject({
      status: "succeeded",
      imageMode: "unavailable",
      error: "image_projection_unavailable",
      screenshot: expect.stringContaining("没有看到"),
    });
    expect(JSON.stringify(projected)).not.toContain("AQID");
    expect(fixture.invoke).toHaveBeenCalledTimes(loss === "replacement" ? 2 : 1);
    images.clearAll();
  },
);

it("shows a browser screenshot to the model, and strips it when the model cannot take images", async () => {
  const invoke = vi.fn(async () => ({ status: "succeeded", output: { data: "AQID", mediaType: "image/jpeg", text: '{"targetId":"tab1"}' } }));
  const browser = (imageInput: { mode: "native" } | { mode: "unavailable" }) =>
    createWorkspaceComputerTools(
      { invoke, activity: new ComputerActivity() } as never,
      { platform: "test", channelId: "channel", type: "direct" },
      { deviceId: "test" },
      new EphemeralImageProjectionStore(),
      (name) => name === "computer_browser",
      undefined,
      imageInput,
    )[0]!;
  const execution = { runtime: { id: "runtime" }, toolCallId: "browser", turnId: "turn", messages: [] } as never;
  const native = browser({ mode: "native" });
  const seen = await native.execute({ action: "screenshot", targetId: "tab1" }, execution);
  expect(seen).toMatchObject({ status: "succeeded", imageMode: "native", screenshot: expect.stringContaining("图的像素") });
  const model = (await native.toModelOutput!({ toolCallId: "browser", output: seen } as never)) as { value: Array<{ type: string; data?: string }> };
  expect(model.value.find((part) => part.type === "image-data")?.data).toBe("AQID");
  const blind = await browser({ mode: "unavailable" }).execute({ action: "screenshot", targetId: "tab1" }, execution);
  expect(blind).toMatchObject({ status: "succeeded", imageMode: "unavailable", error: "image_input_unavailable" });
  expect(JSON.stringify(blind)).not.toContain("AQID");
});

const ctx = () => ({ runtime: { id: "runtime-1" }, toolCallId: "call-1", turnId: "turn-1", messages: [], abortSignal: new AbortController().signal }) as never;
function computer(capabilities: string[] | Error) {
  const invoke = vi.fn().mockResolvedValue({ status: "succeeded", output: { text: "ok" } });
  const list = vi.fn(async () => {
    if (capabilities instanceof Error) throw capabilities;
    return [{ deviceId: "test", capabilities }];
  });
  const tools = createWorkspaceComputerTools(
    { invoke, list, activity: new ComputerActivity() } as never,
    { platform: "onebot", channelId: "private:test", type: "direct" } as never,
    { deviceId: "test" },
    new EphemeralImageProjectionStore(),
    () => true,
  );
  const tool = (name: string) => tools.find((item) => item.name === name)!;
  return { invoke, tool };
}

it("refuses a malformed sequence before it reaches the computer, naming the fix", async () => {
  const { invoke, tool } = computer(["computer.desktop"]);
  // The shape a model sent on 2026-11-16: computer_browser-style steps and a wait without `ms`.
  const result = await tool("computer_ui").execute(
    {
      tool: "sequence",
      args: {
        actions: [
          { action: "press", key: "ctrl+l" },
          { action: "wait", duration_ms: 1000 },
        ],
      },
    } as never,
    ctx(),
  );
  expect(result).toMatchObject({ status: "rejected", code: "invalid_desktop_input" });
  expect((result as { message: string }).message).toContain("没有执行任何动作");
  expect((result as { message: string }).message).toContain("第 1 步只能有 tool 和 args");
  expect(await tool("computer_ui").execute({ tool: "drag_and_drop" } as never, ctx())).toMatchObject({ code: "invalid_desktop_input" });
  expect(invoke).not.toHaveBeenCalled();
  await tool("computer_ui").execute({ tool: "sequence", args: { actions: [{ tool: "wait", args: { ms: 500 } }] } } as never, ctx());
  expect(invoke).toHaveBeenCalledOnce();
});

it("sends the login shapes a model used on 2026-11-16, and refuses malformed browser calls with the fix", async () => {
  const { invoke, tool } = computer(["computer.browser"]);
  for (const input of [
    { action: "x", targetId: "tab1" },
    { action: "fill", targetId: "tab1", ref: "e1" },
    { action: "click", targetId: "tab1", ref: "password" },
    { action: "press", targetId: "tab1", key: "Backspace" },
    { action: "sequence", targetId: "tab1", actions: [] },
    { action: "sequence", targetId: "tab1", actions: [{ action: "fill", targetId: "tab1", ref: "e1", text: "x" }] },
    // Preview records, 2026-11-19: the device refused this without saying why.
    { action: "navigate", targetId: "tab1", url: "about:blank" },
    { action: "navigate", targetId: "tab1", url: "example.com" },
  ])
    expect(await tool("computer_browser").execute(input as never, ctx())).toMatchObject({
      status: "rejected",
      code: "invalid_browser_input",
      message: expect.stringContaining("没有执行任何动作"),
    });
  const nested = await tool("computer_browser").execute(
    { action: "sequence", targetId: "tab1", actions: [{ action: "fill", targetId: "tab1", ref: "e1", text: "x" }] } as never,
    ctx(),
  );
  expect((nested as { message: string }).message).toContain("第 1 步 fill 不接受 targetId");
  expect(invoke).not.toHaveBeenCalled();
  // No snapshot named, and a click before a fill: both are the device's to run now.
  await tool("computer_browser").execute({ action: "fill", targetId: "tab1", ref: "e1", text: "x" } as never, ctx());
  await tool("computer_browser").execute(
    {
      action: "sequence",
      targetId: "tab1",
      actions: [
        { action: "click", ref: "e1" },
        { action: "fill", ref: "e1", text: "x" },
        { action: "press", key: "Tab" },
        { action: "click", ref: "e4" },
      ],
    } as never,
    ctx(),
  );
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("uses only the connected browser: launching any browser is refused, other programs are not", async () => {
  const { invoke, tool } = computer(["computer.desktop", "computer.browser", "computer.shell"]);
  for (const input of [
    { tool: "launch", args: { app: "firefox-esr" } },
    { tool: "launch", args: { app: "chromium" } },
    { tool: "launch", args: { app: "Google Chrome" } },
    {
      tool: "sequence",
      args: {
        actions: [
          { tool: "press", args: { combo: "super" } },
          { tool: "launch", args: { app: "/usr/bin/firefox" } },
        ],
      },
    },
  ])
    expect(await tool("computer_ui").execute(input as never, ctx())).toMatchObject({ status: "rejected", code: "fixed_browser_only" });
  for (const command of [
    "firefox-esr https://www.natfrp.com/user/",
    "DISPLAY=:99 nohup /usr/lib/chromium/chromium &",
    'cd /tmp && "msedge.exe" x',
    // Handing a web address to the desktop's default browser is using another browser too.
    "xdg-open https://www.natfrp.com/user/",
    'DISPLAY=:99 gio open "http://example.test/"',
  ])
    expect(await tool("computer_exec").execute({ command } as never, ctx())).toMatchObject({ status: "rejected", code: "fixed_browser_only" });
  expect(invoke).not.toHaveBeenCalled();
  await tool("computer_ui").execute({ tool: "launch", args: { app: "pcmanfm-qt" } } as never, ctx());
  await tool("computer_exec").execute({ command: "pkill firefox-esr; echo firefox" } as never, ctx());
  await tool("computer_exec").execute({ command: "xdg-open ./report.pdf; curl -s https://example.test/" } as never, ctx());
  expect(invoke).toHaveBeenCalledTimes(3);
});

it("lets a computer without a connected browser start one", async () => {
  for (const capabilities of [["computer.desktop", "computer.shell"], new Error("gateway offline")]) {
    const { invoke, tool } = computer(capabilities);
    await tool("computer_ui").execute({ tool: "launch", args: { app: "firefox-esr" } } as never, ctx());
    await tool("computer_exec").execute({ command: "firefox-esr https://example.test/" } as never, ctx());
    expect(invoke).toHaveBeenCalledTimes(2);
  }
});
