import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import type { DeviceView } from "@yesimbot/contracts";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import * as vue from "vue";

import * as shared from "../src/shared/device-screen";
import * as screen from "../web/src/lib/computer-screen";

const device = (deviceId: string, capabilities: string[], online = true, features?: string[]) =>
  ({ deviceId, name: deviceId, online, capabilities, ...(features ? { features } : {}) }) as unknown as DeviceView;

it("picks an online computer with a desktop and words every capture failure", () => {
  const list = [device("files", ["workspace.files"]), device("off", ["computer.desktop"], false), device("on", ["computer.desktop", "computer.shell"])];
  expect(screen.pickScreenDevice(list)).toBe("on");
  expect(screen.pickScreenDevice(list, "off")).toBe("off");
  expect(screen.pickScreenDevice(list.slice(0, 2))).toBe("off");
  expect(screen.pickScreenDevice([device("files", ["workspace.files"])])).toBe("files");
  expect(screen.pickScreenDevice([])).toBeUndefined();

  expect(screen.screenProblem(409, { message: "screen_unavailable", reason: "offline" })).toEqual({
    text: "电脑不在线，连上之后这里会显示它的屏幕。",
    stop: false,
  });
  expect(screen.screenProblem(409, { message: "screen_unavailable", reason: "no_desktop" }).text).toContain("没有开放桌面操作");
  // Only this reason is fixed by updating the client, so only it links to the download.
  expect(screen.screenProblem(409, { message: "screen_unavailable", reason: "update_required" })).toEqual({
    text: expect.stringContaining("更新客户端"),
    stop: false,
    update: true,
  });
  expect(screen.screenProblem(409, { message: "screen_unavailable", reason: "offline" }).update).toBeUndefined();
  expect(screen.screenProblem(409, { message: "screen_unavailable", reason: "not_ready" }).text).toBe("桌面服务还没就绪，稍后会自动重试。");
  expect(screen.screenProblem(504, { message: "screen_timeout" })).toEqual({ text: "截屏超时了，稍后会自动重试。", stop: false });
  expect(screen.screenProblem(503).stop).toBe(false);
  // An unknown computer and a server without the route both stop the loop.
  expect(screen.screenProblem(404, { message: "not_found" })).toEqual({ text: "找不到这台电脑，它可能已经被撤销。", stop: true });
  expect(screen.screenProblem(404)).toEqual({ text: "这台服务器的版本还不支持看屏幕。", stop: true });
  expect(screen.screenProblem(401).stop).toBe(true);

  expect([0, 1, 2, 3, 4, 9].map(screen.backoff)).toEqual([3000, 6000, 12000, 24000, 30000, 30000]);
});

it("shows the bot's browser first wherever the computer can show it", () => {
  const both = device("both", ["computer.desktop", "computer.browser"], true, ["screen-view", "browser-view"]);
  const old = device("old", ["computer.desktop", "computer.browser"], true, ["screen-view"]);
  const browserOnly = device("browser", ["computer.browser"], true, ["browser-view"]);
  expect([both, old, browserOnly, undefined].map(screen.defaultScreenSource)).toEqual(["browser", "desktop", "browser", "desktop"]);
  expect(screen.pickScreenDevice([device("files", ["workspace.files"]), browserOnly])).toBe("browser");

  const problem = (reason: string) => screen.screenProblem(409, { message: "screen_unavailable", reason }, "browser");
  expect(problem("no_browser").text).toContain("切到「桌面」");
  expect(problem("update_required")).toEqual({ text: expect.stringContaining("更新客户端"), stop: false, update: true });
  expect(problem("not_ready").text).toBe("bot 的浏览器还没就绪，稍后会自动重试。");
  expect(problem("offline").text).toBe("电脑不在线，连上之后这里会显示它的屏幕。");
});

const source = readFileSync(new URL("../web/src/components/ComputerScreen.vue", import.meta.url), "utf8");

it("compiles its template", () => {
  const { descriptor } = parse(source);
  const result = compileTemplate({ source: descriptor.template!.content, filename: "ComputerScreen.vue", id: "computer-screen" });
  expect(result.errors).toEqual([]);
});

type View = {
  source: vue.Ref<"browser" | "desktop">;
  takeOverTarget: vue.Ref<string>;
  remoteDesktop: vue.Ref<boolean>;
  choose(value: unknown): void;
  takeOver(): void;
  imageUrl: vue.Ref<string>;
  problem: vue.Ref<string>;
  paused: vue.Ref<boolean>;
  selected: vue.Ref<string | undefined>;
  capturedAt: vue.Ref<number>;
  stopped: vue.Ref<boolean>;
  zoomed: vue.Ref<boolean>;
  root: vue.Ref<HTMLElement | undefined>;
  openZoom(event: MouseEvent): void;
  openScreen(event: MouseEvent): void;
  closeZoom(): void;
  restoreZoomFocus(event?: Event): void;
};

function mount(options: { devices: DeviceView[]; responses: (() => Response)[]; hidden?: boolean; compact?: boolean }) {
  const { descriptor } = parse(source);
  const code = ts.transpileModule(compileScript(descriptor, { id: "computer-screen" }).content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mounted: (() => void)[] = [],
    unmounted: (() => void)[] = [];
  const timers = new Map<number, { run: () => void; delay: number }>();
  let nextTimer = 1,
    nextUrl = 1;
  const fetches: string[] = [];
  const fetch = vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
    fetches.push(url);
    const next = options.responses.shift();
    if (!next) throw new TypeError("no response");
    const response = next();
    init?.signal?.addEventListener("abort", () => void response.body?.cancel().catch(() => {}));
    return response;
  });
  const urls = { createObjectURL: vi.fn(() => `blob:${nextUrl++}`), revokeObjectURL: vi.fn() };
  const listeners = new Map<string, () => void>();
  const document = {
    visibilityState: options.hidden ? "hidden" : "visible",
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const control = { release: vi.fn(), toggle: vi.fn(), busy: vue.ref(false), token: vue.ref(""), controlled: vue.ref("desktop"), error: vue.ref("") };
  const imports: Record<string, unknown> = {
    vue: { ...vue, onMounted: (fn: () => void) => mounted.push(fn), onBeforeUnmount: (fn: () => void) => unmounted.push(fn) },
    "../../../src/shared/device-screen": shared,
    "../lib/computer-screen": screen,
    "../lib/computer-control": { useComputerControl: () => control },
    "../lib/format": { formatTime: () => "07:00:00" },
    "../nav": { settingsPages: { computer: { path: "/settings/computer" } } },
    "../shell/Icon.vue": { default: {} },
    "./ComputerInput.vue": { default: {} },
    "./RemoteDesktop.vue": { default: {} },
    "./PickerMenu.vue": { default: {} },
  };
  const module = { exports: {} as { default: { setup: (props: unknown, context: unknown) => Record<string, unknown> } } };
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name: string) => imports[name],
    fetch,
    URL: urls,
    Blob,
    document,
    AbortController,
    setTimeout: (run: () => void, delay: number) => {
      timers.set(nextTimer, { run, delay });
      return nextTimer++;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const props = vue.reactive({ computers: options.devices, active: true, compact: options.compact ?? false });
  const scope = vue.effectScope();
  const emit = vi.fn();
  const view = scope.run(() => module.exports.default.setup(props, { expose() {}, emit })) as unknown as View;
  mounted.forEach((fn) => fn());
  /** Runs the pending timer with this delay. */
  const fire = (delay: number) => {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    if (!entry) throw new Error(`no ${delay} ms timer; have ${[...timers.values()].map((timer) => timer.delay)}`);
    timers.delete(entry[0]);
    entry[1].run();
  };
  const delays = () => [...timers.values()].map((timer) => timer.delay).sort((a, b) => a - b);
  return { view, control, fetches, urls, timers, delays, fire, listeners, document, unmount: () => unmounted.forEach((fn) => fn()), props, emit };
}

const flush = async () => {
  for (let index = 0; index < 8; index++) await new Promise((resolve) => setImmediate(resolve));
};
const image = (at = 1000) =>
  new Response(new Blob(["png"], { type: "image/png" }), { headers: { "X-Captured-At": String(at), "X-Screen-Width": "1920", "X-Screen-Height": "1080" } });
const failure = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const frame = (at: number) =>
  shared.encodeScreenRecord({ type: "frame", mediaType: "image/png", size: 3, capturedAt: at, width: 1280, height: 800 }, new Uint8Array([1, 2, 3]));
/** A stream response: these records, then (unless `open`) its end. */
function live(records: Uint8Array[], open = false) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const record of records) controller.enqueue(record);
        if (!open) controller.close();
      },
    }),
    { headers: { "content-type": shared.SCREEN_STREAM_TYPE } },
  );
}
const stream = "/yesimbot/api/v1/devices/screen/stream?deviceId=pc";

it("returns screenshot zoom focus to the actual pointer trigger or its replacement", () => {
  const h = mount({ devices: [], responses: [] });
  h.view.imageUrl.value = "blob:screen";
  const trigger = { isConnected: true, focus: vi.fn() };
  const click = { currentTarget: trigger as unknown as EventTarget | null };
  h.view.openScreen(click as unknown as MouseEvent);
  click.currentTarget = null;
  expect(h.view.zoomed.value).toBe(true);
  h.view.closeZoom();
  const preventDefault = vi.fn();
  h.view.restoreZoomFocus({ preventDefault } as unknown as Event);
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(trigger.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  trigger.isConnected = false;
  const replacement = { focus: vi.fn() };
  const querySelector = vi.fn(() => replacement);
  h.view.root.value = { querySelector } as unknown as HTMLElement;
  h.view.restoreZoomFocus({ preventDefault } as unknown as Event);
  expect(querySelector).toHaveBeenCalledWith("button[data-screen-zoom]:not(:disabled)");
  expect(replacement.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  h.unmount();
});

it("keeps focus inside an open zoom and does not restore it into a hidden computer panel", async () => {
  const h = mount({ devices: [], responses: [] });
  h.view.imageUrl.value = "blob:screen";
  const trigger = { isConnected: true, focus: vi.fn() };
  h.view.openZoom({ currentTarget: trigger } as unknown as MouseEvent);
  const preventDefault = vi.fn();
  h.view.restoreZoomFocus({ preventDefault } as unknown as Event);
  expect(preventDefault).toHaveBeenCalledOnce();
  h.props.active = false;
  await flush();
  expect(h.view.zoomed.value).toBe(false);
  h.view.restoreZoomFocus({ preventDefault } as unknown as Event);
  expect(preventDefault).toHaveBeenCalledTimes(2);
  expect(trigger.focus).not.toHaveBeenCalled();
  h.unmount();
});

it("leaves compact preview expansion to its parent dialog", () => {
  const h = mount({ devices: [], responses: [], compact: true });
  h.view.imageUrl.value = "blob:screen";
  h.view.openScreen({ currentTarget: { isConnected: true, focus: vi.fn() } } as unknown as MouseEvent);
  expect(h.emit).toHaveBeenCalledExactlyOnceWith("expand");
  expect(h.view.zoomed.value).toBe(false);
  h.unmount();
});

it("restores the zoom button after closing a teleported remote desktop", async () => {
  const pc = { ...device("pc", ["computer.desktop"]), features: ["desktop-stream"] };
  const h = mount({ devices: [pc], responses: [() => live([frame(1000)], true)] });
  await flush();
  h.control.token.value = "manual-lease";
  await flush();
  const trigger = { isConnected: true, focus: vi.fn() };
  h.view.openZoom({ currentTarget: trigger } as unknown as MouseEvent);
  h.view.closeZoom();
  await flush();
  expect(h.view.zoomed.value).toBe(false);
  expect(trigger.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  h.unmount();
});

it("shows each streamed picture, keeps the last one through a problem, and opens the next stream when one ends", async () => {
  const pc = device("pc", ["computer.desktop"]);
  const { view, fetches, urls, delays, fire, unmount, listeners, timers } = mount({
    devices: [pc],
    responses: [
      () =>
        live([
          frame(1000),
          frame(2000),
          shared.encodeScreenRecord({ type: "problem", status: 409, body: { message: "screen_unavailable", reason: "offline" } }),
        ]),
      () => live([frame(3000)], true),
    ],
  });
  await flush();
  expect(fetches).toEqual([stream]);
  expect(view.imageUrl.value).toBe("blob:2");
  expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:1");
  expect(view.capturedAt.value).toBe(2000);
  // The last good picture stays, with the problem worded over it.
  expect(view.problem.value).toBe("电脑不在线，连上之后这里会显示它的屏幕。");
  expect(delays()).toEqual([screen.STREAM_RECONNECT_MS]);
  fire(screen.STREAM_RECONNECT_MS);
  await flush();
  expect(fetches).toEqual([stream, stream]);
  expect(view.imageUrl.value).toBe("blob:3");
  expect(view.problem.value).toBe("");
  // A stream that stops producing records after a good frame also gets a watchdog.
  expect(delays()).toEqual([screen.STREAM_IDLE_MS]);

  unmount();
  expect(timers.size).toBe(0);
  expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:3");
  expect(listeners.size).toBe(0);
});

it("falls back to one picture a second on a server without the stream, or when nothing comes through", async () => {
  const pc = device("pc", ["computer.desktop"]);
  // The fallback is remembered for the page, so each case runs in its own module context.
  const old = mount({ devices: [pc], responses: [() => new Response("Not Found", { status: 404 }), () => image(1000), () => image(2000)] });
  await flush();
  expect(old.delays()).toEqual([0]);
  old.fire(0);
  await flush();
  expect(old.fetches).toEqual([stream, "/yesimbot/api/v1/devices/screen?deviceId=pc"]);
  expect(old.view.imageUrl.value).toBe("blob:1");
  expect(old.delays()).toEqual([screen.POLL_INTERVAL]);
  old.fire(screen.POLL_INTERVAL);
  await flush();
  expect(old.view.capturedAt.value).toBe(2000);

  const held = mount({ devices: [pc], responses: [() => live([], true), () => image(1000)] });
  await flush();
  expect(held.delays()).toEqual([screen.STREAM_FIRST_RECORD_MS]);
  held.fire(screen.STREAM_FIRST_RECORD_MS);
  await flush();
  held.fire(0);
  await flush();
  expect(held.fetches.at(-1)).toBe("/yesimbot/api/v1/devices/screen?deviceId=pc");
  expect(held.view.imageUrl.value).toBe("blob:1");
});

it("does nothing while hidden or paused, and stops where retrying cannot help", async () => {
  const pc = device("pc", ["computer.desktop"]);
  const hidden = mount({ devices: [pc], responses: [() => live([frame(1000)], true)], hidden: true });
  await flush();
  expect(hidden.fetches).toEqual([]);
  expect(hidden.timers.size).toBe(0);
  hidden.document.visibilityState = "visible";
  hidden.listeners.get("visibilitychange")!();
  await flush();
  expect(hidden.fetches).toHaveLength(1);
  hidden.view.paused.value = true;
  await flush();
  expect(hidden.delays()).toEqual([]);

  const gone = mount({ devices: [pc], responses: [() => live([shared.encodeScreenRecord({ type: "problem", status: 404, body: { message: "not_found" } })])] });
  await flush();
  expect(gone.view.problem.value).toBe("找不到这台电脑，它可能已经被撤销。");
  expect(gone.view.stopped.value).toBe(true);
  expect(gone.delays()).toEqual([]);
  const denied = mount({ devices: [pc], responses: [() => failure(403, { message: "owner_required" })] });
  await flush();
  expect(denied.view.stopped.value).toBe(true);
  expect(denied.delays()).toEqual([]);
});

it("never asks a computer without a desktop for its screen, and switching computers starts over", async () => {
  const files = device("files", ["workspace.files", "computer.shell"]);
  const pc = device("pc", ["computer.desktop"]);
  const first = mount({ devices: [files], responses: [() => image()] });
  await flush();
  expect(first.fetches).toEqual([]);

  const second = mount({ devices: [files, pc], responses: [() => live([frame(1000)], true)] });
  await flush();
  expect(second.view.selected.value).toBe("pc");
  expect(second.fetches).toEqual([stream]);
  second.view.selected.value = "files";
  await flush();
  expect(second.view.imageUrl.value).toBe("");
  expect(second.urls.revokeObjectURL).toHaveBeenCalledWith("blob:1");
  expect(second.fetches).toHaveLength(1);
});

it("recovers a stream that silently stalls after its first image", async () => {
  const app = mount({ devices: [device("pc", ["computer.desktop"])], responses: [() => live([frame(1000)], true), () => image(2000)] });
  await flush();
  app.fire(screen.STREAM_IDLE_MS);
  await flush();
  expect(app.view.problem.value).toContain("重新获取");
  app.fire(0);
  await flush();
  expect(app.view.capturedAt.value).toBe(2000);
  expect(app.fetches.at(-1)).toBe("/yesimbot/api/v1/devices/screen?deviceId=pc");
  app.unmount();
});

it("keeps receiving frames during continuous manual input without reconnecting", async () => {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        writer = controller;
      },
    }),
  );
  const app = mount({ devices: [device("pc", ["computer.desktop"])], responses: [() => response] });
  await flush();
  app.control.token.value = "manual-lease";
  for (let i = 1; i <= 20; i++) {
    app.control.busy.value = true;
    await flush();
    writer.enqueue(frame(i * 1000));
    await flush();
    expect(app.view.capturedAt.value).toBe(i * 1000);
    app.control.busy.value = false;
    await flush();
  }
  expect(app.fetches).toEqual([stream]);
  expect(app.view.problem.value).toBe("");
  app.unmount();
});

it("keeps fallback polling active while manual input is pending", async () => {
  const app = mount({
    devices: [device("pc", ["computer.desktop"])],
    responses: [() => new Response("Not Found", { status: 404 }), () => image(1000), () => image(2000)],
  });
  await flush();
  app.fire(0);
  await flush();
  app.control.token.value = "manual-lease";
  app.control.busy.value = true;
  await flush();
  app.fire(screen.POLL_INTERVAL);
  await flush();
  expect(app.view.capturedAt.value).toBe(2000);
  app.unmount();
});

it("releases takeover and stops a retained computer panel when its sidebar is hidden", async () => {
  const pc = device("pc", ["computer.desktop"]);
  const h = mount({ devices: [pc], responses: [() => live([frame(1000)], true), () => live([frame(2000)], true)] });
  await flush();
  expect(h.fetches).toHaveLength(1);
  h.view.zoomed.value = true;
  h.props.active = false;
  await flush();
  expect(h.control.release).toHaveBeenCalled();
  expect(h.view.zoomed.value).toBe(false);
  expect(h.delays()).toEqual([]);
  expect(h.view.selected.value).toBe("pc");
  h.props.active = true;
  await flush();
  expect(h.fetches).toHaveLength(2);
  expect(h.view.selected.value).toBe("pc");
  h.unmount();
});

it("watches the bot's browser by default, switches to the desktop on request, and takes over on the desktop when the client cannot take over the browser", async () => {
  const pc = device("pc", ["computer.desktop", "computer.browser"], true, ["screen-view", "browser-view"]);
  const { view, fetches, control, props } = mount({
    devices: [pc],
    responses: [() => live([frame(1000)], true), () => live([frame(2000)], true), () => live([frame(3000)], true), () => live([frame(4000)], true)],
  });
  await flush();
  expect(view.source.value).toBe("browser");
  expect(fetches).toEqual([`${stream}&source=browser`]);
  expect(view.imageUrl.value).toBe("blob:1");

  view.choose("desktop");
  await flush();
  expect(fetches).toEqual([`${stream}&source=browser`, stream]);
  expect(view.imageUrl.value).toBe("blob:2");
  // A list refresh keeps what the owner picked.
  props.computers = [{ ...pc }];
  await flush();
  expect(view.source.value).toBe("desktop");
  expect(fetches).toHaveLength(2);
  view.choose("browser");
  await flush();
  expect(fetches.at(-1)).toBe(`${stream}&source=browser`);

  // Taking over controls the desktop, so the view goes there first.
  view.takeOver();
  await flush();
  expect(view.source.value).toBe("desktop");
  expect(control.toggle).toHaveBeenCalledTimes(1);
  expect(fetches.at(-1)).toBe(stream);
});

it("takes over the bot browser where it is shown, and the desktop where that is shown", async () => {
  const pc = device("pc", ["computer.desktop", "computer.browser"], true, ["screen-view", "browser-view", "browser-control"]);
  const { view, fetches, control } = mount({
    devices: [pc],
    responses: [() => live([frame(1000)], true), () => live([frame(2000)], true), () => live([frame(3000)], true)],
  });
  await flush();
  expect(view.source.value).toBe("browser");
  expect(view.takeOverTarget.value).toBe("浏览器");
  view.takeOver();
  await flush();
  // The view stays on the browser: that is what is taken over.
  expect(view.source.value).toBe("browser");
  expect(control.toggle).toHaveBeenCalledTimes(1);
  expect(fetches).toEqual([`${stream}&source=browser`]);
  control.controlled.value = "browser";
  control.token.value = "lease";
  await flush();
  expect(view.source.value).toBe("browser");
  expect(view.takeOverTarget.value).toBe("浏览器");
  expect(view.remoteDesktop.value).toBe(false);
  control.token.value = "";
  view.choose("desktop");
  await flush();
  expect(view.takeOverTarget.value).toBe("电脑");
  view.takeOver();
  expect(view.source.value).toBe("desktop");
  expect(control.toggle).toHaveBeenCalledTimes(2);
});

it("stays on the desktop of a computer whose client cannot show the browser yet", async () => {
  const pc = device("pc", ["computer.desktop", "computer.browser"], true, ["screen-view"]);
  const { view, fetches } = mount({ devices: [pc], responses: [() => live([frame(1000)], true)] });
  await flush();
  expect(view.source.value).toBe("desktop");
  expect(fetches).toEqual([stream]);
});
