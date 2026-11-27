import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import * as vue from "vue";

async function surface() {
  const { descriptor } = parse(readFileSync(new URL("../web/src/components/RemoteDesktop.vue", import.meta.url), "utf8"));
  expect(compileTemplate({ source: descriptor.template!.content, filename: "RemoteDesktop.vue", id: "remote" }).errors).toEqual([]);
  const code = ts.transpileModule(compileScript(descriptor, { id: "remote" }).content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  let mount!: () => Promise<void>, unmount!: () => void;
  const sendKey = vi.fn(),
    dispatchEvent = vi.fn(),
    focus = vi.fn();
  let instance!: Remote, socket!: Channel;
  class Remote {
    scaleViewport?: boolean;
    resizeSession?: boolean;
    listeners: Record<string, Function> = {};
    sendKey = sendKey;
    disconnect = vi.fn();
    constructor() {
      instance = this;
    }
    addEventListener(event: string, fn: Function) {
      this.listeners[event] = fn;
    }
  }
  class Channel {
    listeners: Record<string, Function> = {};
    send = vi.fn();
    close = vi.fn();
    constructor(readonly url: URL) {
      socket = this;
    }
    addEventListener(event: string, fn: Function) {
      this.listeners[event] = fn;
    }
  }
  const module = { exports: {} as { default: { setup(props: unknown, context: unknown): unknown } } };
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name: string) =>
      name === "vue"
        ? {
            ...vue,
            onMounted(fn: typeof mount) {
              mount = fn;
            },
            onBeforeUnmount(fn: typeof unmount) {
              unmount = fn;
            },
          }
        : { default: Remote },
    setTimeout,
    clearTimeout,
    URL,
    WebSocket: Channel,
    location: { href: "https://console.test/chat", protocol: "https:" },
    KeyboardEvent: class {
      constructor(
        readonly type: string,
        value: unknown,
      ) {
        Object.assign(this, value);
      }
    },
  });
  const emit = vi.fn(),
    view = module.exports.default.setup({ deviceId: "device", token: "lease" }, { expose() {}, emit }) as {
      screen: vue.Ref<unknown>;
      input: vue.Ref<{ value: string; focus(): void }>;
      composed(event: unknown): void;
      typed(event: unknown): void;
      key(event: unknown): void;
    };
  view.screen.value = { querySelector: () => ({ dispatchEvent }) };
  view.input.value = { value: "", focus };
  await mount();
  socket.listeners.open();
  instance.listeners.connect();
  return { view, socket, instance, emit, sendKey, dispatchEvent, unmount };
}
it("authenticates without query secrets, sends Unicode input once, and preserves native key transitions", async () => {
  const f = await surface();
  expect(f.socket.url.href).toBe("wss://console.test/yesimbot/api/v1/devices/desktop");
  expect(JSON.parse(f.socket.send.mock.calls[0][0])).toEqual({ deviceId: "device", token: "lease" });
  f.view.input.value.value = "中文";
  f.view.composed({ target: f.view.input.value });
  f.view.typed({ target: f.view.input.value });
  expect(f.sendKey.mock.calls).toEqual([
    [0x01004e2d, null],
    [0x01006587, null],
  ]);
  const event = { key: "a", code: "KeyA", type: "keydown", preventDefault: vi.fn(), stopPropagation: vi.fn() };
  f.view.key(event);
  f.view.key({ ...event, type: "keyup" });
  expect(f.dispatchEvent.mock.calls.map((call) => call[0].type)).toEqual(["keydown", "keyup"]);
  expect(f.instance.scaleViewport).toBe(true);
  expect(f.instance.resizeSession).toBe(false);
  f.unmount();
});
it("closes without reconnecting and tears down the VNC client on unmount", async () => {
  const f = await surface();
  f.socket.listeners.close();
  expect(f.emit).toHaveBeenCalledWith("disconnected");
  f.unmount();
  expect(f.instance.disconnect).toHaveBeenCalledTimes(1);
  expect(f.socket.close).toHaveBeenCalledTimes(1);
});
