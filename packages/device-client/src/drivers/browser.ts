import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { isBrowserControl, isScreenViewRead, type ControlAction, type ConversationIdentity, type OperationResult } from "@yesimbot/contracts";
import { AppError, type Clock, newId, resolveInside, systemClock } from "@yesimbot/foundation";
import WebSocket from "ws";
import { z } from "zod/v4";

import { localDesktopEndpoint } from "../config.js";
import type { DeviceDriver } from "../driver.js";
import { conversationWorkspace } from "./files.js";

const targetId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/** Refs are those of the tab's latest page (from inspect or the last action's result); `snapshot` may pin which one. */
const selected = { targetId, snapshot: z.string().uuid().optional(), ref: z.string().regex(/^e\d{1,4}$/) };

const key = z.enum(["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp", "PageDown", "PageUp"]);

/** A point in the pixels of the tab's latest screenshot. */
const pixel = z.number().int().min(0).max(16384);

/** A key combo in xdotool names (`ctrl+c`, `Return`, `shift+Tab`, `F5`), for terminals and canvases. */
const combo = z
  .string()
  .regex(
    /^(?:(?:ctrl|alt|shift|cmd)\+){0,3}(?:[a-z0-9]|F(?:[1-9]|1[0-2])|Return|Tab|Escape|BackSpace|Delete|Left|Up|Right|Down|Home|End|Page_Up|Page_Down|space)$/,
  );

/** Files a page may receive: relative to the conversation's folder, or absolute inside it or a project folder. */
const uploadPath = z.string().min(1).max(4096);

/** One wheel notch, in CSS pixels. */
const WHEEL_NOTCH = 100;

/** How long a button that should open a file chooser may take to do it. */
const FILE_CHOOSER_WAIT_MS = 5000;

const browserAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), ref: selected.ref }).strict(),
  z.object({ action: z.literal("fill"), ref: selected.ref, text: z.string().max(16000) }).strict(),
  z.object({ action: z.literal("press"), key }).strict(),
]);

const browserInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tabs") }).strict(),
  z.object({ action: z.literal("inspect"), targetId }).strict(),
  z
    .object({
      action: z.literal("navigate"),
      targetId,
      url: z
        .string()
        .url()
        .refine((value) => ["https:", "http:", "file:"].includes(new URL(value).protocol)),
    })
    .strict(),
  z.object({ action: z.literal("click"), ...selected }).strict(),
  z.object({ action: z.literal("fill"), ...selected, text: z.string().max(16000) }).strict(),
  z.object({ action: z.literal("press"), targetId, key }).strict(),
  // Captchas, canvases and other parts the element list cannot reach: look at the tab, click a point of it.
  z.object({ action: z.literal("screenshot"), targetId }).strict(),
  z.object({ action: z.literal("click_at"), targetId, x: pixel, y: pixel }).strict(),
  // Web terminals (xterm), canvases and editors that ignore fill: keys sent one by one to what has focus (click it first).
  z.object({ action: z.literal("type"), targetId, text: z.string().min(1).max(4000) }).strict(),
  z.object({ action: z.literal("hotkey"), targetId, keys: combo }).strict(),
  // The wheel at a screenshot pixel: scrolls whatever is under it (a list, a terminal, a map), not only the page. dy > 0 scrolls down.
  z
    .object({
      action: z.literal("scroll"),
      targetId,
      x: pixel,
      y: pixel,
      dy: z
        .number()
        .int()
        .min(-50)
        .max(50)
        .refine((value) => value !== 0),
    })
    .strict(),
  // Files for a file field, or for the file chooser a button opens.
  z.object({ action: z.literal("upload"), ...selected, files: z.array(uploadPath).min(1).max(10) }).strict(),
  z
    .object({
      action: z.literal("sequence"),
      targetId,
      snapshot: selected.snapshot,
      // Each step rechecks its ref, so steps after a navigation stop instead of acting on the old page.
      actions: z.array(browserAction).min(1).max(8),
    })
    .strict(),
]);

/** A catch handler that turns a failure before any page action into a refusal, unless the operation was aborted. */
const namedKeys: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  BackSpace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  Up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  Right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  Page_Up: { key: "PageUp", code: "PageUp", keyCode: 33 },
  Page_Down: { key: "PageDown", code: "PageDown", keyCode: 34 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

/** Editing shortcuts Chromium runs only as commands when the key comes from CDP. */
const editCommands: Record<string, string> = { a: "selectAll", c: "copy", x: "cut", z: "undo", y: "redo" };

type BrowserAction = z.infer<typeof browserAction>;

type Snapshot = { id: string; contextId: number };

type CdpCall = <M extends keyof CdpResults>(method: M, params?: unknown) => Promise<CdpResults[M]>;

export interface BrowserPage {
  snapshot: string;
  targetId: string;
  loaderId?: string;
  url: string;
  title: string;
  readyState: string;
  text: string;
  elements: Array<{ ref: string; tag: string; role: string | null; name: string; type: string | null; disabled: boolean; value?: string }>;
  frames: Array<{ title: string; src: string }>;
  settled?: boolean;
}

interface CdpResults {
  "Page.enable": unknown;
  "Page.bringToFront": unknown;
  "Page.handleJavaScriptDialog": unknown;
  "Page.getFrameTree": { frameTree: { frame: { id: string; loaderId?: string } } };
  "Page.createIsolatedWorld": { executionContextId: number };
  "Page.navigate": { loaderId?: string; errorText?: string };
  "Runtime.evaluate": { result?: { value?: unknown; objectId?: string }; exceptionDetails?: unknown };
  "DOM.setFileInputFiles": unknown;
  "Page.setInterceptFileChooserDialog": unknown;
  "Page.captureScreenshot": { data?: string };
  "Input.dispatchKeyEvent": unknown;
  "Input.dispatchMouseEvent": unknown;
  "Input.insertText": unknown;
}

/**
 * Page operations on a configured local browser: elements by ref, and screenshot points for what has no
 * element. No arbitrary model-authored JavaScript.
 */
export class LocalBrowserDriver implements DeviceDriver {
  readonly capability = "computer.browser" as const;
  private busy = false;
  private stopped = false;
  private current?: WebSocket;
  private available = false;
  private snapshots = new Map<string, Snapshot>();
  /** The tab the bot last acted on or looked at: what the owner's screen view shows. */
  private lastTarget?: string;
  private viewing = false;
  constructor(
    private readonly endpoint: string,
    /** Where uploaded files may come from: the conversation folders under `workspaceRoot` and the project folders. */
    private readonly files: { workspaceRoot?: string; projectRoots?: readonly string[] } = {},
    private readonly clock: Clock = systemClock(),
  ) {
    const url = localDesktopEndpoint(endpoint);
    if (url.pathname !== "/") throw new Error("browser_endpoint_root_required");
  }
  private probedAt = 0;
  /** Not reachable yet (e.g. started together with the browser): look again every 30 s, in the background. */
  healthy() {
    if (!this.available && !this.stopped && this.clock.now() - this.probedAt > 30_000) void this.probe(AbortSignal.timeout(5000)).catch(() => {});
    return this.available && !this.stopped;
  }
  readonly methods: DeviceDriver["methods"] = {
    execute: {
      contexts: ["direct", "group"],
      execute: async (invocation, signal) => {
        if (isScreenViewRead(invocation)) return this.watch(signal);
        const control = isBrowserControl(invocation) ? (invocation.input as { input: ControlAction }).input : undefined;
        const parsed = control ? undefined : browserInputSchema.safeParse(invocation.input);
        if (parsed && !parsed.success) return { status: "rejected", code: "invalid_browser_input" };
        if (this.stopped || this.busy || signal.aborted) return { status: "rejected", code: "browser_unavailable" };
        this.busy = true;
        try {
          return {
            status: "succeeded",
            output: control ? await this.control(control, signal) : await this.run(parsed!.data!, signal, invocation.conversation),
          };
        } catch (cause) {
          if (cause instanceof BrowserRefusal && !signal.aborted) return { status: "rejected", code: cause.code };
          throw cause;
        } finally {
          this.busy = false;
        }
      },
    },
  };
  async probe(signal: AbortSignal) {
    this.probedAt = this.clock.now();
    await this.tabs(signal);
  }
  private async tabs(signal: AbortSignal): Promise<Array<{ id: string; title: string; url: string; webSocketDebuggerUrl: string }>> {
    // Only the endpoint decides availability: one tab's socket failing (a crash, a closed popup) must not mark the whole browser down.
    const response = await fetch(new URL("/json/list", this.endpoint), { signal, redirect: "error" }).catch((cause) => {
      this.available = false;
      throw cause;
    });
    if (!response.ok || Number(response.headers.get("content-length")) > 1024 * 1024) throw new Error("browser_unavailable");
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error("browser_response_too_large");
    const data = z
      .array(z.object({ type: z.string(), id: targetId, title: z.string(), url: z.string(), webSocketDebuggerUrl: z.string().optional() }))
      .max(500)
      .parse(JSON.parse(text));
    this.available = true;
    return data
      .filter((page) => page.type === "page" && page.webSocketDebuggerUrl)
      .map((page) => {
        const ws = new URL(page.webSocketDebuggerUrl!),
          base = new URL(this.endpoint);
        if (
          ws.protocol !== "ws:" ||
          ws.hostname !== base.hostname ||
          ws.port !== base.port ||
          ws.username ||
          ws.password ||
          ws.search ||
          ws.hash ||
          !ws.pathname.startsWith("/devtools/page/")
        )
          throw new Error("foreign_browser_endpoint");
        return { id: page.id, title: page.title.slice(0, 1000), url: page.url.slice(0, 4096), webSocketDebuggerUrl: ws.href };
      });
  }
  private async run(input: z.infer<typeof browserInputSchema>, signal: AbortSignal, conversation: ConversationIdentity): Promise<unknown> {
    // Until a page action is sent nothing has changed, so failures up to then are refusals, not uncertain results.
    const files = input.action === "upload" ? await this.uploadFiles(input.files, conversation) : undefined;
    const tabs = await this.tabs(signal).catch(refuse(signal, "browser_unavailable"));
    if (input.action === "tabs") return { tabs: tabs.map(({ webSocketDebuggerUrl: _ws, ...page }) => page) };
    const target = tabs.find((tab) => tab.id === input.targetId);
    if (!target) throw new BrowserRefusal("browser_tab_not_found");
    this.lastTarget = target.id;
    let mainFrameId: string | undefined;
    const loadingFrames = new Set<string>();
    const dialogs: Array<{ type: string; message: string; handled: string }> = [];
    const choosers: Array<(backendNodeId: number | undefined) => void> = [];
    const cdp = this.connect(target.webSocketDebuggerUrl, signal, (method, params) => {
      if (method === "Page.fileChooserOpened") choosers.shift()?.(typeof params.backendNodeId === "number" ? params.backendNodeId : undefined);
      const frame = typeof params.frameId === "string" ? params.frameId : undefined;
      if (frame && method === "Page.frameStartedLoading") loadingFrames.add(frame);
      if (frame && (method === "Page.frameStoppedLoading" || method === "Page.frameDetached")) loadingFrames.delete(frame);
      if (method === "Page.javascriptDialogOpening") {
        // An open dialog freezes every other call on the page. Alerts and leave-page prompts are accepted; confirm and prompt are cancelled.
        const type = String(params.type);
        const accept = type === "alert" || type === "beforeunload";
        dialogs.push({ type, message: String(params.message ?? "").slice(0, 300), handled: accept ? "accepted" : "dismissed" });
        void cdp.call("Page.handleJavaScriptDialog", { accept }).catch(() => {});
      }
    });
    const call = cdp.call;
    this.current = cdp.socket;
    try {
      await cdp.opened();
      if (input.action === "inspect" || input.action === "screenshot") {
        // Watching dialogs also frees a page that a dialog froze before this connection; a page that cannot even answer this is hung.
        await call("Page.enable").catch((cause) => {
          if (cause instanceof Error && cause.message === "browser_request_timeout") refuse(signal, "browser_page_unresponsive")(cause);
        });
        if (input.action === "inspect") {
          const page = await this.inspect(call, input.targetId).catch(refuse(signal, "browser_inspection_failed"));
          return dialogs.length ? { ...page, dialogs } : page;
        }
        return await this.screenshot(call, input.targetId, dialogs.length ? { dialogs } : {}).catch(refuse(signal, "browser_screenshot_failed"));
      }
      // Mutations must be visible on the desktop the user watches. Reads do not steal focus.
      let scale = 1;
      try {
        await call("Page.bringToFront");
        await call("Page.enable");
        mainFrameId = (await call("Page.getFrameTree")).frameTree.frame.id;
        if (input.action === "click_at" || input.action === "scroll") scale = (await this.view(call, mainFrameId)).scale;
      } catch (cause) {
        refuse(signal, "browser_unavailable")(cause);
      }
      if (input.action === "click_at") {
        // The click may change the page: refs taken before it are not reused.
        this.snapshots.delete(input.targetId);
        return await this.clickAt(call, input, scale, signal, async () => ({
          ...(dialogs.length ? { dialogs } : {}),
          ...(await this.tabChanges(tabs, input.targetId, signal)),
        }));
      }
      if (input.action === "type" || input.action === "hotkey" || input.action === "scroll") {
        this.snapshots.delete(input.targetId);
        return await this.keysOrWheel(call, input, scale, signal, async () => ({
          ...(dialogs.length ? { dialogs } : {}),
          ...(await this.tabChanges(tabs, input.targetId, signal)),
        }));
      }
      const usesRefs =
        input.action === "click" ||
        input.action === "fill" ||
        input.action === "upload" ||
        (input.action === "sequence" && input.actions.some((step) => step.action !== "press"));
      const snapshot = usesRefs || input.action === "sequence" ? this.snapshots.get(input.targetId) : undefined;
      if (usesRefs && (!snapshot || ("snapshot" in input && input.snapshot && snapshot.id !== input.snapshot)))
        throw new BrowserRefusal("stale_browser_snapshot");
      // Retain the original refs only within this operation; never expose them for replay after effects.
      this.snapshots.delete(input.targetId);
      let completed = 0;
      let error: string | undefined;
      let loaderId: string | undefined;
      let navigating = false;
      const actions = input.action === "sequence" ? input.actions : input.action === "navigate" || input.action === "upload" ? [] : [input];
      try {
        if (input.action === "navigate") {
          // Page.navigate answers once the navigation commits; a server that never answers leaves it pending, which is not a failure.
          const result = await call("Page.navigate", { url: input.url }).catch((cause) => {
            if (cause instanceof Error && cause.message === "browser_request_timeout") return undefined;
            throw cause;
          });
          if (result?.errorText) throw new Error("browser_navigation_failed");
          navigating = !result;
          loaderId = result?.loaderId;
          completed = 1;
        } else if (input.action === "upload") {
          await this.upload(call, input.ref, snapshot!, files!, () => new Promise((resolve) => choosers.push(resolve)), signal);
          completed = 1;
        } else {
          for (const step of actions) {
            signal.throwIfAborted();
            await this.act(call, step, snapshot);
            completed++;
          }
        }
      } catch (cause) {
        if (signal.aborted) throw cause;
        error = cause instanceof Error && /^\w+$/.test(cause.message) ? cause.message : "browser_action_failed";
      }
      // Only observations are retried. A click, insert or key event is never replayed.
      let page: unknown;
      let observationError: string | undefined;
      try {
        page = await this.observe(call, input.targetId, signal, () => !!mainFrameId && loadingFrames.has(mainFrameId), loaderId);
      } catch (cause) {
        if (signal.aborted) throw cause;
        observationError = cause instanceof Error && cause.message === "browser_page_unresponsive" ? cause.message : "browser_observation_unavailable";
      }
      const changes = await this.tabChanges(tabs, input.targetId, signal);
      return {
        action: input.action,
        completed: error === undefined,
        actionsCompleted: completed,
        totalActions: input.action === "navigate" || input.action === "upload" ? 1 : actions.length,
        ...(error
          ? {
              isError: true,
              error,
              failedAt: completed,
              recovery: "Inspect the current state; the failed action may have taken effect. Do not replay the sequence.",
            }
          : {}),
        ...(dialogs.length ? { dialogs } : {}),
        ...changes,
        ...(navigating
          ? { navigating: true, note: "The page has not answered yet and is still loading. Wait, then inspect or screenshot; do not navigate again." }
          : {}),
        ...(page
          ? { page }
          : {
              observationError,
              verification:
                observationError === "browser_page_unresponsive"
                  ? "The page does not answer (hung, or a dialog is open). Try screenshot; if that fails too, use tabs and continue in another tab or navigate this one again."
                  : "Inspect the page before any further action; do not repeat completed actions.",
            }),
      };
    } finally {
      cdp.close();
      if (this.current === cdp.socket) this.current = undefined;
    }
  }
  /** Tabs that appeared (a popup, target=_blank) or vanished since the operation began, so the bot knows where the page went. */
  private async tabChanges(before: Array<{ id: string }>, target: string, signal: AbortSignal) {
    const after = await this.tabs(signal).catch(() => undefined);
    if (!after) return {};
    const opened = after.filter((tab) => !before.some((known) => known.id === tab.id)).map(({ id, title, url }) => ({ targetId: id, title, url }));
    const closed = !after.some((tab) => tab.id === target);
    if (opened[0]) this.lastTarget = opened[0].targetId;
    if (!opened.length && !closed) return {};
    return {
      ...(opened.length ? { newTabs: opened } : {}),
      ...(closed ? { targetClosed: true } : {}),
      tabNote:
        `${opened.length ? "The action opened a new tab (popup or link): continue there with its targetId. " : ""}${closed ? "This tab was closed or replaced: use tabs to find where the page went." : ""}`.trim(),
    };
  }
  /** One CDP connection to a tab. `opened()` refuses when it cannot connect; `close()` ends it; aborting `signal` breaks it. */
  private connect(url: string, signal: AbortSignal, onEvent?: (method: string, params: Record<string, unknown>) => void) {
    const socket = new WebSocket(url, { maxPayload: 8 * 1024 * 1024, handshakeTimeout: 5000 });
    let sequence = 0;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
    const fail = () => {
      for (const p of pending.values()) {
        clearTimeout(p.timeout);
        p.reject(new Error("browser_interrupted"));
      }
      pending.clear();
    };
    const abort = () => {
      fail();
      socket.terminate();
    };
    socket.on("error", fail);
    socket.on("close", fail);
    socket.on("message", (raw) => {
      try {
        const value = JSON.parse(raw.toString()) as { id?: number; error?: unknown; result?: unknown; method?: string; params?: Record<string, unknown> };
        if (value.method) onEvent?.(value.method, value.params ?? {});
        const p = pending.get(value.id ?? -1);
        if (!p) return;
        pending.delete(value.id!);
        clearTimeout(p.timeout);
        if (value.error) p.reject(new Error("browser_action_failed"));
        else p.resolve(value.result);
      } catch {
        abort();
      }
    });
    const call: CdpCall = <M extends keyof CdpResults>(method: M, params: unknown = {}): Promise<CdpResults[M]> =>
      new Promise((resolve, reject) => {
        if (signal.aborted || socket.readyState !== WebSocket.OPEN) {
          reject(new Error("browser_interrupted"));
          return;
        }
        const id = ++sequence;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error("browser_request_timeout"));
        }, 5000);
        pending.set(id, { resolve: (value) => resolve(value as CdpResults[M]), reject, timeout });
        socket.send(JSON.stringify({ id, method, params }));
      });
    signal.addEventListener("abort", abort, { once: true });
    const opened = () =>
      new Promise<void>((resolve, reject) => {
        if (socket.readyState === WebSocket.OPEN) return resolve();
        socket.once("open", resolve);
        socket.once("error", reject);
        socket.once("close", () => reject(new Error("browser_interrupted")));
        if (signal.aborted) abort();
      }).catch(refuse(signal, "browser_unavailable"));
    const close = () => {
      signal.removeEventListener("abort", abort);
      for (const p of pending.values()) clearTimeout(p.timeout);
      socket.removeListener("close", fail);
      socket.close();
    };
    return { socket, call, opened, close };
  }
  /**
   * The owner's view of the bot browser: the tab the bot last used (else the first tab), on a connection of its own.
   * It never waits for or blocks a bot action and never brings a tab to the front.
   */
  private async watch(signal: AbortSignal): Promise<OperationResult> {
    if (this.stopped || this.viewing || signal.aborted) return { status: "rejected", code: "browser_unavailable" };
    this.viewing = true;
    try {
      const tabs = await this.tabs(signal).catch(refuse(signal, "browser_unavailable"));
      const target = tabs.find((tab) => tab.id === this.lastTarget) ?? tabs[0];
      if (!target) throw new BrowserRefusal("browser_tab_not_found");
      const cdp = this.connect(target.webSocketDebuggerUrl, signal);
      try {
        await cdp.opened();
        return { status: "succeeded", output: await this.screenshot(cdp.call, target.id).catch(refuse(signal, "browser_screenshot_failed")) };
      } finally {
        cdp.close();
      }
    } catch (cause) {
      if (cause instanceof BrowserRefusal && !signal.aborted) return { status: "rejected", code: cause.code };
      throw cause;
    } finally {
      this.viewing = false;
    }
  }
  /**
   * The owner's takeover: one input to the tab the owner sees (the bot's last tab, else the first), in pixels of
   * that view. The browser stays on its own screen; nothing reaches the desktop. A link that opens a new tab
   * moves the view there. Inputs are never repeated.
   */
  private async control(action: ControlAction, signal: AbortSignal) {
    const tabs = await this.tabs(signal).catch(refuse(signal, "browser_unavailable"));
    const target = tabs.find((tab) => tab.id === this.lastTarget) ?? tabs[0];
    if (!target) throw new BrowserRefusal("browser_tab_not_found");
    this.lastTarget = target.id;
    const cdp = this.connect(target.webSocketDebuggerUrl, signal);
    const call = cdp.call;
    try {
      await cdp.opened();
      let scale = 1;
      try {
        await call("Page.bringToFront");
        scale = (await this.view(call)).scale;
      } catch (cause) {
        refuse(signal, "browser_unavailable")(cause);
      }
      // The view's pixels are device pixels; input events take CSS pixels.
      const at = (x: number, y: number) => ({ x: x / scale, y: y / scale });
      const mouse = (type: string, point: { x: number; y: number }, extra: Record<string, unknown> = {}) =>
        call("Input.dispatchMouseEvent", { type, ...point, ...extra });
      if (action.type === "move") await mouse("mouseMoved", at(action.x, action.y));
      else if (action.type === "click") {
        const point = at(action.x, action.y);
        await mouse("mouseMoved", point);
        for (let count = 1; count <= (action.count ?? 1); count++) {
          await mouse("mousePressed", point, { button: action.button, clickCount: count });
          await mouse("mouseReleased", point, { button: action.button, clickCount: count });
        }
      } else if (action.type === "drag") {
        const from = at(action.x, action.y),
          to = at(action.toX, action.toY);
        await mouse("mouseMoved", from);
        await mouse("mousePressed", from, { button: "left", clickCount: 1 });
        for (let step = 1; step <= 5; step++)
          await mouse("mouseMoved", { x: from.x + ((to.x - from.x) * step) / 5, y: from.y + ((to.y - from.y) * step) / 5 }, { button: "left", buttons: 1 });
        await mouse("mouseReleased", to, { button: "left", clickCount: 1 });
      } else if (action.type === "scroll") await mouse("mouseWheel", at(action.x, action.y), { deltaX: 0, deltaY: -action.dy * 100 });
      else if (action.type === "text") await call("Input.insertText", { text: action.text });
      else for (const event of keyEvents(action.key)) await call("Input.dispatchKeyEvent", event);
      if (action.type === "click") {
        // A link may open a new tab: show that one from now on.
        await delay(300, undefined, { signal });
        const opened = (await this.tabs(signal).catch(() => tabs)).find((tab) => !tabs.some((known) => known.id === tab.id));
        if (opened) this.lastTarget = opened.id;
      }
      return { action: action.type, completed: true };
    } finally {
      cdp.close();
    }
  }
  private async inspect(call: CdpCall, target: string) {
    const tree = await call("Page.getFrameTree");
    const frame = tree.frameTree.frame;
    const { executionContextId: contextId } = await call("Page.createIsolatedWorld", { frameId: frame.id, worldName: "yesimbot-browser" });
    const id = newId();
    const result = await call("Runtime.evaluate", {
      contextId,
      returnByValue: true,
      expression: `(() => {
        const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"]')].filter(e => e.getClientRects().length).slice(0,300);
        globalThis.__yesimbot = { id: ${JSON.stringify(id)}, elements, url: location.href };
        return { snapshot: ${JSON.stringify(id)}, url: location.href, title: document.title, readyState: document.readyState, text: (document.body?.innerText || '').slice(0,24000), elements: elements.map((e,i) => ({ref:'e'+i,tag:e.tagName,role:e.getAttribute('role'),name:(e.getAttribute('aria-label') || e.innerText || e.getAttribute('placeholder') || '').slice(0,300),type:e.getAttribute('type'),disabled:!!e.disabled,value:e.type!=='password' && 'value' in e ? String(e.value).slice(0,2000) : undefined})), frames:[...document.querySelectorAll('iframe')].map(e=>({title:e.title,src:e.src})).slice(0,20) };
      })()`,
    });
    if (result.exceptionDetails || !result.result?.value) throw new Error("browser_inspection_failed");
    this.snapshots.set(target, { id, contextId });
    return { ...(result.result.value as BrowserPage), targetId: target, loaderId: frame.loaderId };
  }
  /** Return fresh refs after a short quiet period, bounded even for pages that keep changing. */
  private async observe(call: CdpCall, target: string, signal: AbortSignal, loading: () => boolean, loaderId?: string) {
    const deadline = this.clock.now() + 3000;
    let previous: string | undefined;
    let stableAt = this.clock.now();
    let page: Awaited<ReturnType<LocalBrowserDriver["inspect"]>> | undefined;
    let timedOut = false;
    do {
      await delay(100, undefined, { signal });
      try {
        page = await this.inspect(call, target);
        const { snapshot: _snapshot, ...content } = page;
        const fingerprint = JSON.stringify(content);
        if (fingerprint !== previous) stableAt = this.clock.now();
        else if (this.clock.now() - stableAt >= 200 && page.readyState !== "loading" && !loading() && (!loaderId || loaderId === page.loaderId))
          return { ...page, settled: true };
        previous = fingerprint;
      } catch (cause) {
        signal.throwIfAborted();
        timedOut = cause instanceof Error && cause.message === "browser_request_timeout";
        page = undefined;
        previous = undefined;
      }
    } while (this.clock.now() < deadline);
    if (!page || (loaderId && loaderId !== page.loaderId)) {
      this.snapshots.delete(target);
      throw new Error(timedOut ? "browser_page_unresponsive" : "browser_observation_unavailable");
    }
    this.snapshots.delete(target);
    return { ...page, settled: false };
  }
  /** The tab's address, title and device pixel ratio, read in the isolated world. */
  private async view(call: CdpCall, frameId?: string) {
    frameId ??= (await call("Page.getFrameTree")).frameTree.frame.id;
    const { executionContextId: contextId } = await call("Page.createIsolatedWorld", { frameId, worldName: "yesimbot-browser" });
    const result = await call("Runtime.evaluate", {
      contextId,
      returnByValue: true,
      expression: "({ url: location.href, title: document.title, scale: devicePixelRatio })",
    });
    const view = z
      .object({ url: z.string(), title: z.string(), scale: z.number().positive().max(8) })
      .safeParse(result.exceptionDetails ? undefined : result.result?.value);
    if (!view.success) throw new Error("browser_inspection_failed");
    return { url: view.data.url.slice(0, 4096), title: view.data.title.slice(0, 1000), scale: view.data.scale };
  }
  /** The visible part of the tab as JPEG; click_at points are pixels of this image. */
  private async screenshot(call: CdpCall, target: string, details: Record<string, unknown> = {}) {
    const view = await this.view(call);
    const shot = await call("Page.captureScreenshot", { format: "jpeg", quality: 80 });
    if (typeof shot.data !== "string" || !shot.data || !/^[A-Za-z0-9+/]+={0,2}$/.test(shot.data)) throw new Error("browser_screenshot_failed");
    const text = JSON.stringify({ ...details, targetId: target, url: view.url, title: view.title, scale: view.scale });
    return { ...(details.isError ? { isError: true } : {}), data: shot.data, mediaType: "image/jpeg", text };
  }
  /**
   * Typed text, a key combo or a wheel turn, then a fresh screenshot: what a terminal or canvas shows is not in the
   * page text. Text goes key by key to what has focus; a new line is Enter. Nothing is ever repeated.
   */
  private async keysOrWheel(
    call: CdpCall,
    input:
      | { action: "type"; targetId: string; text: string }
      | { action: "hotkey"; targetId: string; keys: string }
      | { action: "scroll"; targetId: string; x: number; y: number; dy: number },
    scale: number,
    signal: AbortSignal,
    changes: () => Promise<Record<string, unknown>>,
  ) {
    let sent = 0;
    let error: string | undefined;
    try {
      if (input.action === "scroll") {
        // Screenshot pixels are device pixels; input events take CSS pixels.
        const point = { x: input.x / scale, y: input.y / scale };
        await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
        await call("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: input.dy * WHEEL_NOTCH });
        sent = 1;
      } else if (input.action === "hotkey") {
        for (const event of keyEvents(input.keys)) await call("Input.dispatchKeyEvent", event);
        sent = 1;
      } else
        for (const character of input.text) {
          signal.throwIfAborted();
          const events = character === "\n" ? keyEvents("Return") : character === "\t" ? keyEvents("Tab") : character === "\r" ? [] : typedCharacter(character);
          for (const event of events) await call("Input.dispatchKeyEvent", event);
          sent++;
        }
    } catch (cause) {
      if (signal.aborted) throw cause;
      error = cause instanceof Error && /^\w+$/.test(cause.message) ? cause.message : "browser_action_failed";
    }
    const total = input.action === "type" ? [...input.text].length : 1;
    const result: Record<string, unknown> = {
      action: input.action,
      completed: error === undefined,
      ...(input.action === "type" ? { charactersSent: sent, totalCharacters: total } : { actionsCompleted: sent, totalActions: 1 }),
      ...(error ? { isError: true, error, recovery: "Look at the new screenshot: part of it may have taken effect. Do not send it all again blindly." } : {}),
    };
    // Let the page draw what it received before looking.
    await delay(400, undefined, { signal });
    Object.assign(result, await changes());
    try {
      return await this.screenshot(call, input.targetId, result);
    } catch (cause) {
      if (signal.aborted) throw cause;
      return { ...result, observationError: "browser_screenshot_unavailable", verification: "Take a screenshot before any further action; do not repeat it." };
    }
  }
  /** The files for an upload as real paths inside the conversation's folder or a project folder; refused before any page action. */
  private async uploadFiles(paths: readonly string[], conversation: ConversationIdentity): Promise<string[]> {
    if (!this.files.workspaceRoot) throw new BrowserRefusal("browser_upload_unavailable");
    const folder = conversationWorkspace(this.files.workspaceRoot, conversation);
    const files: string[] = [];
    for (const path of paths) {
      const real = await realUploadPath(isAbsolute(path) ? [folder, ...(this.files.projectRoots ?? [])] : [folder], path);
      if (!(await stat(real)).isFile()) throw new BrowserRefusal("upload_not_a_file");
      files.push(real);
    }
    return files;
  }
  /**
   * Gives the files to a file field directly, or to the file chooser the element opens when clicked (a styled button).
   * The chooser is intercepted, so no dialog appears on the desktop.
   */
  private async upload(call: CdpCall, ref: string, snapshot: Snapshot, files: string[], chooser: () => Promise<number | undefined>, signal: AbortSignal) {
    const index = Number(ref.slice(1));
    const current = `const s=globalThis.__yesimbot; if(!s || s.id!==${JSON.stringify(snapshot.id)} || s.url!==location.href) return null; const e=s.elements[${index}]; if(!e || !e.isConnected || e.disabled) return null;`;
    const kind = await call("Runtime.evaluate", {
      contextId: snapshot.contextId,
      returnByValue: true,
      expression: `(() => { ${current} return e.matches('input[type=file]') ? 'field' : 'other'; })()`,
    });
    if (kind.exceptionDetails || !kind.result?.value) throw new Error("stale_browser_snapshot");
    if (kind.result.value === "field") {
      const element = await call("Runtime.evaluate", { contextId: snapshot.contextId, expression: `(() => { ${current} return e; })()` });
      if (!element.result?.objectId) throw new Error("stale_browser_snapshot");
      await call("DOM.setFileInputFiles", { files, objectId: element.result.objectId });
      return;
    }
    await call("Page.setInterceptFileChooserDialog", { enabled: true });
    try {
      const opened = chooser();
      await this.act(call, { action: "click", ref }, snapshot);
      const backendNodeId = await Promise.race([opened, delay(FILE_CHOOSER_WAIT_MS, "timeout" as const, { signal })]);
      if (backendNodeId === "timeout" || backendNodeId === undefined) throw new Error("browser_file_chooser_not_opened");
      await call("DOM.setFileInputFiles", { files, backendNodeId });
    } finally {
      await call("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
  }
  /** One left click at a screenshot pixel, then a fresh screenshot. The click is never repeated. */
  private async clickAt(
    call: CdpCall,
    input: { targetId: string; x: number; y: number },
    scale: number,
    signal: AbortSignal,
    /** Facts about what the click did to the browser, read after the page had time to react; they travel in the screenshot's text. */
    changes: () => Promise<Record<string, unknown>>,
  ) {
    // Screenshot pixels are device pixels; input events take CSS pixels.
    const x = input.x / scale,
      y = input.y / scale;
    let error: string | undefined;
    try {
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    } catch (cause) {
      if (signal.aborted) throw cause;
      error = cause instanceof Error && /^\w+$/.test(cause.message) ? cause.message : "browser_action_failed";
    }
    const result: Record<string, unknown> = {
      action: "click_at",
      completed: error === undefined,
      actionsCompleted: error === undefined ? 1 : 0,
      totalActions: 1,
      ...(error
        ? { isError: true, error, failedAt: 0, recovery: "Look at the new screenshot; the click may have taken effect. Do not repeat it blindly." }
        : {}),
    };
    // Let the page react (a selection mark, a dialog) before looking.
    await delay(400, undefined, { signal });
    Object.assign(result, await changes());
    try {
      return await this.screenshot(call, input.targetId, result);
    } catch (cause) {
      if (signal.aborted) throw cause;
      return {
        ...result,
        observationError: "browser_screenshot_unavailable",
        verification: "Take a screenshot before any further action; do not repeat the click.",
      };
    }
  }
  private async act(call: CdpCall, input: BrowserAction, snapshot?: Snapshot) {
    if (input.action === "press") {
      if (snapshot) {
        const result = await call("Runtime.evaluate", {
          contextId: snapshot.contextId,
          returnByValue: true,
          expression: `(() => { const s=globalThis.__yesimbot; return !!s && s.id===${JSON.stringify(snapshot.id)} && s.url===location.href && (!s.focused || (s.focused.isConnected && document.activeElement===s.focused)); })()`,
        });
        if (result.exceptionDetails || result.result?.value !== true) throw new Error("stale_browser_focus");
      }
      const code = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, PageDown: 34, PageUp: 33 }[input.key];
      await call("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: input.key,
        code: input.key,
        windowsVirtualKeyCode: code,
        ...(input.key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
      });
      await call("Input.dispatchKeyEvent", { type: "keyUp", key: input.key, code: input.key, windowsVirtualKeyCode: code });
      // A key such as Tab moves focus on purpose: later keys of the sequence go where it now is.
      if (snapshot)
        await call("Runtime.evaluate", {
          contextId: snapshot.contextId,
          expression: `(() => { const s=globalThis.__yesimbot; if (s && s.id===${JSON.stringify(snapshot.id)}) s.focused=document.activeElement; })()`,
        });
      return;
    }
    if (!snapshot) throw new Error("stale_browser_snapshot");
    const index = Number(input.ref.slice(1));
    const result = await call("Runtime.evaluate", {
      contextId: snapshot.contextId,
      returnByValue: true,
      expression: `(() => {
        const s=globalThis.__yesimbot; if(!s || s.id!==${JSON.stringify(snapshot.id)} || s.url!==location.href) return {error:'stale_browser_snapshot'};
        const e=s.elements[${index}]; if(!e || !e.isConnected || e.disabled) return {error:'browser_element_unavailable'};
        e.scrollIntoView({block:'center',inline:'center'}); e.focus(); s.focused=e; const r=e.getBoundingClientRect();
        if(!r.width || !r.height) return {error:'browser_element_unavailable'};
        const x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);
        if(!hit || (hit!==e && !e.contains(hit))) return {error:'browser_element_obscured'};
        return {x,y,editable:e.matches('input,textarea,[contenteditable="true"]')};
      })()`,
    });
    const point = result.result?.value as { x: number; y: number; editable: boolean; error?: string } | undefined;
    if (result.exceptionDetails || !point) throw new Error("stale_browser_snapshot");
    if (point.error) throw new Error(point.error);
    if (input.action === "click") {
      await call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    } else {
      if (!point.editable) throw new Error("browser_element_not_editable");
      const modifiers = process.platform === "darwin" ? 4 : 2;
      await call("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers, commands: ["selectAll"] });
      await call("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers });
      await call("Input.insertText", { text: input.text });
    }
  }
  async close() {
    this.stopped = true;
    this.current?.terminate();
    this.snapshots.clear();
  }
}

/** Refused before any page action was sent: nothing changed, so the bot may correct and retry. */
class BrowserRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** CDP key events for an xdotool-style combo. The browser runs on Linux, so ⌘ acts as Ctrl. */
function keyEvents(combo: string): Array<Record<string, unknown>> {
  const parts = combo.split("+");
  const name = parts.pop()!;
  const held = new Set(parts.map((part) => (part === "cmd" ? "ctrl" : part)));
  const modifiers = (held.has("alt") ? 1 : 0) | (held.has("ctrl") ? 2 : 0) | (held.has("shift") ? 8 : 0);
  const fn = /^F(\d+)$/.exec(name);
  const key = namedKeys[name] ?? (fn ? { key: name, code: name, keyCode: 111 + Number(fn[1]) } : undefined);
  const plain = /^[a-z0-9]$/.test(name) ? name : undefined;
  const base = key ?? {
    key: held.has("shift") && plain ? plain.toUpperCase() : plain!,
    code: /\d/.test(plain!) ? `Digit${plain}` : `Key${plain!.toUpperCase()}`,
    keyCode: plain!.toUpperCase().charCodeAt(0),
  };
  // Typed characters arrive as text; with Ctrl or Alt held a letter is a shortcut, not text.
  const text = key ? key.text : held.has("ctrl") || held.has("alt") ? undefined : base.key;
  const command = held.has("ctrl") && plain ? (plain === "z" && held.has("shift") ? "redo" : editCommands[plain]) : undefined;
  return [
    {
      type: text ? "keyDown" : "rawKeyDown",
      key: base.key,
      code: base.code,
      windowsVirtualKeyCode: base.keyCode,
      modifiers,
      ...(text ? { text, unmodifiedText: text } : {}),
      ...(command ? { commands: [command] } : {}),
    },
    { type: "keyUp", key: base.key, code: base.code, windowsVirtualKeyCode: base.keyCode, modifiers },
  ];
}

/** CDP events typing one character: its key, with the character as text, so key handlers (xterm) and inputs both get it. */
function typedCharacter(character: string): Array<Record<string, unknown>> {
  return [
    { type: "keyDown", key: character, text: character, unmodifiedText: character },
    { type: "keyUp", key: character },
  ];
}

/**
 * The real path of an upload inside one of `roots`, links followed only as far as they stay inside it. A relative path
 * belongs to the first root (the conversation's folder).
 */
async function realUploadPath(roots: readonly string[], path: string): Promise<string> {
  let missing = false;
  for (const root of roots) {
    try {
      return await resolveInside(root, path, { links: "within" });
    } catch (cause) {
      // A missing root (the conversation's folder before its first file) holds nothing; the next root may.
      if ((cause instanceof AppError && cause.code === "path_missing") || (!isAbsolute(path) && (cause as NodeJS.ErrnoException).code === "ENOENT"))
        missing = true;
    }
  }
  throw new BrowserRefusal(missing ? "upload_file_not_found" : "upload_path_outside_roots");
}

function refuse(signal: AbortSignal, code: string) {
  return (cause: unknown): never => {
    if (signal.aborted) throw cause;
    if (cause instanceof BrowserRefusal) throw cause;
    throw new BrowserRefusal(cause instanceof Error && cause.message === "browser_request_timeout" ? "browser_page_unresponsive" : code);
  };
}

// Exported here: it is built from the local schemas above it.
export { browserInputSchema };
