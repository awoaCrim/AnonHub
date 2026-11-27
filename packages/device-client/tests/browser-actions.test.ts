import { createServer } from "node:http";
import { runInNewContext } from "node:vm";

import { BROWSER_VIEW_READ, SCREEN_VIEW_PLATFORM, type DeviceInvocation } from "@yesimbot/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { LocalBrowserDriver } from "../src/drivers/browser.js";

const cleanup: Array<() => Promise<void>> = [];
/** A bot call from a chat, or (on the viewer platform) the owner's screen view. */
const invocation = (input: unknown, platform = "onebot") =>
  ({
    operationId: "22222222-2222-4222-8222-222222222222",
    capability: "computer.browser",
    method: "execute",
    input,
    conversation: { tenantId: "11111111-1111-4111-8111-111111111111", platform, botId: "bot", kind: "direct", conversationId: "private:owner" },
    actors: [],
    expiresAt: Date.now() + 10_000,
  }) as DeviceInvocation;
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function browser() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const state = {
    text: "Search",
    url: "https://example.test/",
    failRef: -1,
    failInsert: false,
    connections: 0,
    onInsert: () => {},
    scale: 1,
    screenshots: 0,
    failScreenshot: false,
    tabs: ["tab1"],
    /** Holds the answer to the bot's text input, to see what else can happen meanwhile. */
    hold: Promise.resolve(),
    /** A tab that a click opens (a link with target=_blank). */
    opensTab: "",
    /** The page no longer answers Runtime/screenshot calls (hung renderer, or a dialog freezing it). */
    hung: false,
    /** A dialog the next click raises; the page stays frozen until it is handled. */
    dialogOnClick: "" as "" | "alert" | "confirm",
    handledDialogs: [] as boolean[],
    dropSocket: false,
  };
  const server = createServer((_request, response) => {
    const port = (server.address() as { port: number }).port;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        state.tabs.map((id) => ({ type: "page", id, title: "Example", url: state.url, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${id}` })),
      ),
    );
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket, request) => {
    state.connections++;
    const tab = request.url?.split("/").pop();
    socket.on("message", async (raw) => {
      const command = JSON.parse(raw.toString());
      calls.push({ ...command, tab });
      let result: unknown = {};
      let error: unknown;
      if (state.hung && ["Runtime.evaluate", "Page.captureScreenshot", "Page.createIsolatedWorld"].includes(command.method)) return;
      if (state.dropSocket && command.method === "Page.captureScreenshot") return socket.terminate();
      switch (command.method) {
        case "Page.handleJavaScriptDialog":
          state.handledDialogs.push(command.params.accept);
          state.hung = false;
          break;
        case "Page.getFrameTree":
          result = { frameTree: { frame: { id: "frame1", loaderId: state.url } } };
          break;
        case "Page.createIsolatedWorld":
          result = { executionContextId: 1 };
          break;
        case "Runtime.evaluate": {
          const expression = command.params.expression as string;
          if (expression.includes("document.querySelectorAll")) {
            const snapshot = /snapshot:\s*"([^"]+)"/.exec(expression)![1];
            result = {
              result: {
                value: {
                  snapshot,
                  url: state.url,
                  title: "Example",
                  readyState: "complete",
                  text: state.text,
                  elements: [
                    { ref: "e0", tag: "input" },
                    { ref: "e1", tag: "input" },
                    { ref: "e2", tag: "button" },
                  ],
                },
              },
            };
          } else if (expression.includes("devicePixelRatio")) {
            result = { result: { value: { url: state.url, title: "Example", scale: state.scale } } };
          } else if (expression.includes("stale_browser_snapshot")) {
            const ref = Number(/s\.elements\[(\d+)\]/.exec(expression)![1]);
            result = { result: { value: ref === state.failRef ? { error: "browser_element_unavailable" } : { x: 10, y: 10, editable: ref !== 2 } } };
          } else result = { result: { value: true } };
          break;
        }
        case "Page.navigate":
          state.url = command.params.url;
          state.text = "New page";
          result = { loaderId: state.url };
          break;
        case "Page.captureScreenshot":
          state.screenshots++;
          if (state.failScreenshot) error = { message: "Unable to capture screenshot" };
          else result = { data: "/9j/AAAA" };
          break;
        case "Input.insertText":
          state.text = command.params.text;
          state.onInsert();
          if (state.failInsert) error = { message: "Disconnected after delivery" };
          break;
        case "Input.dispatchKeyEvent":
          if (command.params.key === "Enter") state.text = "Results";
          break;
        case "Input.dispatchMouseEvent":
          if (command.params.type === "mouseReleased" && state.opensTab) state.tabs.push(state.opensTab);
          if (command.params.type === "mouseReleased" && state.dialogOnClick) {
            state.hung = true;
            socket.send(JSON.stringify({ method: "Page.javascriptDialogOpening", params: { type: state.dialogOnClick, message: "Leave?" } }));
          }
          break;
      }
      if (command.method === "Input.insertText") await state.hold;
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ id: command.id, ...(error ? { error } : { result }) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const driver = new LocalBrowserDriver(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
  cleanup.push(() => driver.close());
  const execute = async (input: unknown, signal = new AbortController().signal) => driver.methods.execute!.execute(invocation(input), signal);
  const view = async () => driver.methods.execute!.execute(invocation(structuredClone(BROWSER_VIEW_READ), SCREEN_VIEW_PLATFORM), new AbortController().signal);
  /** The owner's takeover input, in the reserved control scope. */
  const control = async (input: unknown) => {
    const call = invocation({ action: "control", input }, SCREEN_VIEW_PLATFORM);
    return driver.methods.execute!.execute(
      { ...call, conversation: { ...call.conversation, botId: "webui", conversationId: "control" } },
      new AbortController().signal,
    );
  };
  const inspect = async () => {
    const result = await execute({ action: "inspect", targetId: "tab1" });
    expect(result.status).toBe("succeeded");
    return (result as { output: { snapshot: string } }).output;
  };
  return { calls, state, execute, inspect, view, control, driver };
}

it("fills and submits in one browser operation, then returns fresh usable page refs", async () => {
  const { execute, inspect, state, calls } = await browser();
  const before = await inspect();
  const result = await execute({
    action: "sequence",
    targetId: "tab1",
    snapshot: before.snapshot,
    actions: [
      { action: "fill", ref: "e0", text: "hello" },
      { action: "press", key: "Enter" },
    ],
  });
  expect(result).toMatchObject({
    status: "succeeded",
    output: { completed: true, actionsCompleted: 2, totalActions: 2, page: { text: "Results", targetId: "tab1", settled: true } },
  });
  expect(state.connections).toBe(2); // inspect, then the entire sequence plus its observation
  const page = (result as { output: { page: { snapshot: string } } }).output.page;
  expect(page.snapshot).not.toBe(before.snapshot);
  // A stale snapshot sends no page action: a refusal the bot may correct, not an uncertain result.
  expect(await execute({ action: "fill", targetId: "tab1", snapshot: before.snapshot, ref: "e0", text: "stale" })).toEqual({
    status: "rejected",
    code: "stale_browser_snapshot",
  });
  const next = await execute({ action: "fill", targetId: "tab1", snapshot: page.snapshot, ref: "e1", text: "next field" });
  expect(next).toMatchObject({ status: "succeeded", output: { completed: true, page: { text: "next field" } } });
  expect(calls.filter((c) => c.method === "Input.insertText").map((c) => c.params.text)).toEqual(["hello", "next field"]);
});

it("returns the destination page from navigate without a separate inspect call", async () => {
  const { execute } = await browser();
  expect(await execute({ action: "navigate", targetId: "tab1", url: "https://example.test/next" })).toMatchObject({
    status: "succeeded",
    output: { completed: true, page: { url: "https://example.test/next", text: "New page", settled: true } },
  });
});

it("rechecks each ref, stops on a replaced element and returns current state with partial progress", async () => {
  const { execute, inspect, state, calls } = await browser();
  const before = await inspect();
  state.failRef = 1;
  const result = await execute({
    action: "sequence",
    targetId: "tab1",
    snapshot: before.snapshot,
    actions: [
      { action: "fill", ref: "e0", text: "first" },
      { action: "fill", ref: "e1", text: "second" },
      { action: "click", ref: "e2" },
    ],
  });
  expect(result).toMatchObject({
    status: "succeeded",
    output: { isError: true, error: "browser_element_unavailable", actionsCompleted: 1, failedAt: 1, totalActions: 3, page: { text: "first" } },
  });
  expect(calls.filter((c) => c.method === "Input.insertText")).toHaveLength(1);
  expect(calls.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(false);
});

it("never repeats an action whose delivery is uncertain", async () => {
  const { execute, inspect, state, calls } = await browser();
  const before = await inspect();
  state.failInsert = true;
  expect(
    await execute({
      action: "sequence",
      targetId: "tab1",
      snapshot: before.snapshot,
      actions: [
        { action: "fill", ref: "e0", text: "possibly delivered" },
        { action: "press", key: "Enter" },
      ],
    }),
  ).toMatchObject({ status: "succeeded", output: { isError: true, actionsCompleted: 0, failedAt: 0, page: { text: "possibly delivered" } } });
  expect(calls.filter((c) => c.method === "Input.insertText")).toHaveLength(1);
  expect(calls.some((c) => c.method === "Input.dispatchKeyEvent" && c.params.key === "Enter")).toBe(false);
});

it("runs click and key steps anywhere in a sequence, rejects empty or long ones and stops on cancellation", async () => {
  const { execute, inspect, state, calls } = await browser();
  const before = await inspect();
  for (const actions of [[], Array.from({ length: 9 }, () => ({ action: "fill", ref: "e0", text: "too many" }))]) {
    expect(await execute({ action: "sequence", targetId: "tab1", snapshot: before.snapshot, actions })).toEqual({
      status: "rejected",
      code: "invalid_browser_input",
    });
  }
  expect(calls.some((c) => c.method.startsWith("Input."))).toBe(false);
  // Account, Tab, password, submit: the login form the bot could not fill as one sequence before.
  const mixed = await execute({
    action: "sequence",
    targetId: "tab1",
    snapshot: before.snapshot,
    actions: [
      { action: "click", ref: "e0" },
      { action: "fill", ref: "e0", text: "user" },
      { action: "press", key: "Tab" },
      { action: "press", key: "Tab" },
      { action: "fill", ref: "e1", text: "secret" },
      { action: "click", ref: "e2" },
    ],
  });
  expect(mixed).toMatchObject({ status: "succeeded", output: { completed: true, actionsCompleted: 6, totalActions: 6 } });
  expect(calls.filter((c) => c.method === "Input.insertText").map((c) => c.params.text)).toEqual(["user", "secret"]);
  const controller = new AbortController();
  state.onInsert = () => controller.abort();
  const after = await inspect();
  await expect(
    execute(
      {
        action: "sequence",
        targetId: "tab1",
        snapshot: after.snapshot,
        actions: [
          { action: "fill", ref: "e0", text: "stop here" },
          { action: "press", key: "Enter" },
        ],
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(calls.some((c) => c.method === "Input.dispatchKeyEvent" && c.params.key === "Enter")).toBe(false);
});

it("acts on the tab's latest page when no snapshot is named, and needs a page first", async () => {
  const { execute, inspect, calls } = await browser();
  expect(await execute({ action: "fill", targetId: "tab1", ref: "e0", text: "too early" })).toEqual({ status: "rejected", code: "stale_browser_snapshot" });
  expect(calls.some((c) => c.method.startsWith("Input."))).toBe(false);
  await inspect();
  const filled = await execute({ action: "fill", targetId: "tab1", ref: "e0", text: "latest" });
  expect(filled).toMatchObject({ status: "succeeded", output: { completed: true, page: { text: "latest" } } });
  // The result's page is now the latest one: the next step needs no snapshot either.
  expect(await execute({ action: "click", targetId: "tab1", ref: "e2" })).toMatchObject({ status: "succeeded", output: { completed: true } });
});

it("fills password fields like any other input", async () => {
  const { execute, inspect, calls } = await browser();
  await inspect();
  await execute({ action: "fill", targetId: "tab1", ref: "e1", text: "secret" });
  const script = calls.find((c) => c.method === "Runtime.evaluate" && String(c.params.expression).includes("s.elements[1]"))!.params.expression as string;
  const id = /s\.id!==("[^"]+")/.exec(script)![1]!;
  const password = {
    type: "password",
    isConnected: true,
    disabled: false,
    scrollIntoView() {},
    focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20 }),
    matches: () => true,
    contains: () => false,
  };
  const page = {
    globalThis: { __yesimbot: { id: JSON.parse(id), url: "https://login.test/", elements: [{}, password] } },
    location: { href: "https://login.test/" },
    document: { elementFromPoint: () => password },
  };
  page.globalThis = Object.assign(page.globalThis, page);
  expect(runInNewContext(script, page.globalThis)).toEqual({ x: 50, y: 10, editable: true });
  expect(calls.filter((c) => c.method === "Input.insertText").map((c) => c.params.text)).toEqual(["secret"]);
});

it("brings the operated tab to the desktop before mutation, but does not focus read-only inspections", async () => {
  const { execute, inspect, calls } = await browser();
  await inspect();
  expect(calls.some((c) => c.method === "Page.bringToFront")).toBe(false);
  calls.length = 0;
  await execute({ action: "navigate", targetId: "tab1", url: "https://example.test/next" });
  expect(calls.findIndex((c) => c.method === "Page.bringToFront")).toBeLessThan(calls.findIndex((c) => c.method === "Page.navigate"));
});

it("refuses, rather than reports as uncertain, failures before any page action is sent", async () => {
  const { execute, calls } = await browser();
  expect(await execute({ action: "click", targetId: "missing", snapshot: crypto.randomUUID(), ref: "e0" })).toEqual({
    status: "rejected",
    code: "browser_tab_not_found",
  });
  expect(calls.some((c) => c.method.startsWith("Input.") || c.method === "Page.navigate")).toBe(false);

  // Nothing listens on the endpoint: the connected browser is not running.
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = (closed.address() as { port: number }).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const offline = new LocalBrowserDriver(`http://127.0.0.1:${port}/`);
  cleanup.push(() => offline.close());
  for (const input of [{ action: "tabs" }, { action: "navigate", targetId: "tab1", url: "https://example.test/" }])
    expect(await offline.methods.execute!.execute(invocation(input), new AbortController().signal)).toEqual({
      status: "rejected",
      code: "browser_unavailable",
    });
});

it("looks at a tab without focusing it, and clicks a screenshot point in CSS pixels once", async () => {
  const { execute, inspect, state, calls } = await browser();
  const shot = await execute({ action: "screenshot", targetId: "tab1" });
  expect(shot).toMatchObject({ status: "succeeded", output: { data: "/9j/AAAA", mediaType: "image/jpeg" } });
  expect(JSON.parse((shot as { output: { text: string } }).output.text)).toEqual({
    targetId: "tab1",
    url: "https://example.test/",
    title: "Example",
    scale: 1,
  });
  expect(calls.some((c) => c.method === "Page.bringToFront" || c.method.startsWith("Input."))).toBe(false);

  const before = await inspect();
  state.scale = 2;
  calls.length = 0;
  const clicked = await execute({ action: "click_at", targetId: "tab1", x: 200, y: 101 });
  expect(clicked).toMatchObject({ status: "succeeded", output: { data: "/9j/AAAA", mediaType: "image/jpeg" } });
  expect(JSON.parse((clicked as { output: { text: string } }).output.text)).toMatchObject({
    action: "click_at",
    completed: true,
    actionsCompleted: 1,
    scale: 2,
  });
  const mouse = calls.filter((c) => c.method === "Input.dispatchMouseEvent");
  expect(mouse.map((c) => [c.params.type, c.params.x, c.params.y])).toEqual([
    ["mouseMoved", 100, 50.5],
    ["mousePressed", 100, 50.5],
    ["mouseReleased", 100, 50.5],
  ]);
  expect(calls.findIndex((c) => c.method === "Page.bringToFront")).toBeLessThan(calls.indexOf(mouse[0]!));
  // Refs taken before the click are not reused after it.
  expect(await execute({ action: "click", targetId: "tab1", snapshot: before.snapshot, ref: "e2" })).toEqual({
    status: "rejected",
    code: "stale_browser_snapshot",
  });
});

it("refuses bad points and failed looks, and never repeats a click whose result it cannot see", async () => {
  const { execute, state, calls } = await browser();
  for (const point of [{ x: -1, y: 5 }, { x: 1.5, y: 5 }, { x: 5 }])
    expect(await execute({ action: "click_at", targetId: "tab1", ...point })).toEqual({ status: "rejected", code: "invalid_browser_input" });
  expect(calls).toHaveLength(0);
  state.failScreenshot = true;
  expect(await execute({ action: "screenshot", targetId: "tab1" })).toEqual({ status: "rejected", code: "browser_screenshot_failed" });
  const blind = await execute({ action: "click_at", targetId: "tab1", x: 10, y: 10 });
  expect(blind).toMatchObject({ status: "succeeded", output: { action: "click_at", completed: true, observationError: "browser_screenshot_unavailable" } });
  expect(calls.filter((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed")).toHaveLength(1);
});

it("shows the owner the tab the bot last used, on a connection of its own, without focusing it or holding up the bot", async () => {
  const { execute, inspect, view, state, calls } = await browser();
  state.tabs = ["tab0", "tab1"];
  const shown = async () => {
    const result = await view();
    expect(result).toMatchObject({ status: "succeeded", output: { data: "/9j/AAAA", mediaType: "image/jpeg" } });
    return JSON.parse((result as { output: { text: string } }).output.text).targetId;
  };
  // Before the bot used a tab: the first one.
  expect(await shown()).toBe("tab0");
  const page = await inspect();
  expect(await shown()).toBe("tab1");

  // The bot's text input is still waiting for the browser: the view does not wait, and the bot is not refused.
  let release!: () => void;
  state.hold = new Promise((resolve) => (release = resolve));
  const filling = execute({ action: "fill", targetId: "tab1", snapshot: page.snapshot, ref: "e0", text: "query" });
  await vi.waitFor(() => expect(calls.some((call) => call.method === "Input.insertText")).toBe(true));
  expect(await shown()).toBe("tab1");
  release();
  expect(await filling).toMatchObject({ status: "succeeded", output: { completed: true } });

  // Viewing never brings a tab to the front; only the bot's fill did.
  expect(calls.filter((call) => call.method === "Page.bringToFront")).toHaveLength(1);
  // The view is not a bot action, and the bot's form of it is refused.
  expect(await execute(structuredClone(BROWSER_VIEW_READ))).toEqual({ status: "rejected", code: "invalid_browser_input" });
  state.tabs = [];
  expect(await view()).toEqual({ status: "rejected", code: "browser_tab_not_found" });
});

it("lets the owner take over the shown tab: clicks in view pixels, wheel, keys and text, and follows a tab a click opens", async () => {
  const { execute, view, control, state, calls } = await browser();
  state.tabs = ["tab0", "tab1"];
  state.scale = 2;
  // A bot cannot send the owner's input.
  expect(await execute({ action: "control", input: { type: "text", text: "x" } })).toEqual({ status: "rejected", code: "invalid_browser_input" });
  expect(calls).toHaveLength(0);

  expect(await control({ type: "click", x: 20, y: 40, button: "left", count: 2 })).toMatchObject({ status: "succeeded", output: { completed: true } });
  const mouse = calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => c.params);
  // View pixels are device pixels; events take CSS pixels. A double click is two presses.
  expect(mouse).toEqual([
    { type: "mouseMoved", x: 10, y: 20 },
    { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 },
    { type: "mouseReleased", x: 10, y: 20, button: "left", clickCount: 1 },
    { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 2 },
    { type: "mouseReleased", x: 10, y: 20, button: "left", clickCount: 2 },
  ]);
  expect(calls.filter((c) => c.method === "Input.dispatchMouseEvent").every((c) => c.tab === "tab0")).toBe(true);

  calls.length = 0;
  await control({ type: "scroll", x: 0, y: 0, dy: -3 });
  expect(calls.find((c) => c.method === "Input.dispatchMouseEvent")?.params).toMatchObject({ type: "mouseWheel", deltaY: 300 });
  await control({ type: "text", text: "你好" });
  expect(calls.find((c) => c.method === "Input.insertText")?.params).toEqual({ text: "你好" });

  calls.length = 0;
  await control({ type: "key", key: "ctrl+a" });
  await control({ type: "key", key: "cmd+c" });
  await control({ type: "key", key: "Return" });
  await control({ type: "key", key: "shift+Tab" });
  const keys = calls.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => c.params);
  expect(keys[0]).toMatchObject({ type: "rawKeyDown", key: "a", code: "KeyA", modifiers: 2, commands: ["selectAll"] });
  expect(keys[2]).toMatchObject({ type: "rawKeyDown", key: "c", modifiers: 2, commands: ["copy"] });
  expect(keys[4]).toMatchObject({ type: "keyDown", key: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
  expect(keys[6]).toMatchObject({ type: "rawKeyDown", key: "Tab", modifiers: 8 });
  expect(keys.filter((k) => k.type === "keyUp")).toHaveLength(4);

  // A link that opens a new tab: the view and the next input go there.
  state.opensTab = "tab2";
  await control({ type: "click", x: 2, y: 2, button: "left" });
  state.opensTab = "";
  expect(JSON.parse(((await view()) as { output: { text: string } }).output.text).targetId).toBe("tab2");
  calls.length = 0;
  await control({ type: "text", text: "next" });
  expect(calls.find((c) => c.method === "Input.insertText")?.tab).toBe("tab2");
});

it("reports a popup opened by click_at so the bot can continue in the new tab", async () => {
  const { execute, state } = await browser();
  state.opensTab = "popup1";
  expect(await execute({ action: "screenshot", targetId: "tab1" })).toMatchObject({ status: "succeeded" });
  const result = await execute({ action: "click_at", targetId: "tab1", x: 5, y: 5 });
  expect(result).toMatchObject({ status: "succeeded", output: { text: expect.stringContaining("popup1") } });
  expect((result as { output: { text: string } }).output.text).toContain("tabNote");
});

it("handles a dialog raised by a click instead of hanging on it", async () => {
  const { execute, inspect, state } = await browser();
  const before = await inspect();
  state.dialogOnClick = "confirm";
  const result = await execute({ action: "click", targetId: "tab1", snapshot: before.snapshot, ref: "e2" });
  expect(state.handledDialogs).toEqual([false]);
  expect(result).toMatchObject({
    status: "succeeded",
    output: { completed: true, dialogs: [{ type: "confirm", handled: "dismissed" }], page: { settled: true } },
  });
});

it("tells a hung page apart from other failures", { timeout: 20_000 }, async () => {
  const { execute, state } = await browser();
  state.hung = true;
  expect(await execute({ action: "screenshot", targetId: "tab1" })).toEqual({ status: "rejected", code: "browser_page_unresponsive" });
  expect(await execute({ action: "inspect", targetId: "tab1" })).toEqual({ status: "rejected", code: "browser_page_unresponsive" });
});

it("keeps the browser available when one tab's connection breaks", async () => {
  const { execute, state, driver } = await browser();
  expect(await execute({ action: "tabs" })).toMatchObject({ status: "succeeded" });
  state.dropSocket = true;
  await execute({ action: "screenshot", targetId: "tab1" }).catch(() => {});
  expect(driver.healthy()).toBe(true);
});
