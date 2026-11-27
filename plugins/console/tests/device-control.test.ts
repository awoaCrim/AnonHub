import { systemClock } from "@yesimbot/foundation";
import { expect, it, vi } from "vitest";

import type { AdminHttpContext } from "../src/admin-auth";
import { installDeviceControl } from "../src/webui/device-control";

interface ControlHttp extends Pick<AdminHttpContext, "status" | "body" | "set" | "get"> {
  request: { body: unknown };
  req: object;
  res: { destroyed: boolean };
}

const id = "22222222-2222-4222-8222-222222222222",
  token = "11111111-1111-4111-8111-111111111111";
function setup() {
  let handler: (http: ControlHttp) => Promise<void>;
  const devices = {
    list: vi.fn(async () => [{ deviceId: id, platform: "linux" }]),
    acquireControl: vi.fn(async () => token),
    renewControl: vi.fn(() => true),
    releaseControl: vi.fn(),
    controlInput: vi.fn(async () => ({ status: "succeeded", output: { secret: "not returned" } })),
    controlBrowser: vi.fn(async () => ({ status: "succeeded", output: { completed: true } })),
  };
  installDeviceControl(
    {
      on() {},
      yesimbot: { devices },
      clock: systemClock(),
      server: {
        ws() {},
        post(_path: string, fn: typeof handler) {
          handler = fn;
        },
      },
    } as never,
    {
      onRevocation: () => () => {},
      sessionFromCookie: (cookie: string) => (cookie ? { role: cookie === "member" ? "member" : "owner" } : undefined),
      sameOrigin: (http: Pick<ControlHttp, "get">) => http.get("origin") === "https://console.test",
    } as never,
  );
  async function call(body: unknown, cookie = "owner", origin = "https://console.test") {
    const http: ControlHttp = {
      status: 200,
      body: undefined,
      request: { body },
      req: {},
      res: { destroyed: false },
      set() {},
      get: (name: string) => ({ cookie, origin, "content-type": "application/json" })[name] ?? "",
    };
    await handler!(http);
    return http;
  }
  return { devices, call };
}
it("requires same-origin runtime-owner authentication before acquiring or input", async () => {
  const { call, devices } = setup();
  expect((await call({ deviceId: id, op: "acquire" }, "")).status).toBe(401);
  expect((await call({ deviceId: id, op: "acquire" }, "member")).status).toBe(403);
  expect((await call({ deviceId: id, op: "acquire" }, "owner", "https://foreign.test")).status).toBe(403);
  expect(devices.acquireControl).not.toHaveBeenCalled();
});
it("binds the lease to the login and device, validates input and excludes private results", async () => {
  const { call, devices } = setup();
  expect((await call({ deviceId: id, op: "acquire" })).body).toEqual({ token });
  expect((await call({ deviceId: id, op: "input", token, action: { type: "text", text: "private" } }, "another-login")).status).toBe(409);
  expect((await call({ deviceId: id, op: "input", token, action: { type: "click", x: -1, y: 1 } })).status).toBe(400);
  expect(devices.controlInput).not.toHaveBeenCalled();
  expect((await call({ deviceId: id, op: "input", token, action: { type: "click", x: 12, y: 30 } })).body).toEqual({ ok: true });
  expect(devices.controlInput).toHaveBeenCalledWith(id, token, { tool: "mouse_click", args: { xy: "12,30", button: "left" } }, expect.any(AbortSignal));
  expect((await call({ deviceId: id, op: "release", token })).body).toEqual({ ok: true });
  expect((await call({ deviceId: id, op: "input", token, action: { type: "text", text: "private" } })).status).toBe(409);
});
it("takes over the bot browser on request and sends it the input as it is, never as desktop tools", async () => {
  const { call, devices } = setup();
  expect((await call({ deviceId: id, op: "acquire", source: "window" })).status).toBe(400);
  expect((await call({ deviceId: id, op: "acquire", source: "browser" })).body).toEqual({ token });
  expect(devices.acquireControl).toHaveBeenCalledWith(id, "browser");
  expect((await call({ deviceId: id, op: "input", token, action: { type: "text", text: "你好" } })).body).toEqual({ ok: true });
  expect(devices.controlBrowser).toHaveBeenCalledWith(id, token, { type: "text", text: "你好" }, expect.any(AbortSignal));
  expect(devices.controlInput).not.toHaveBeenCalled();
  devices.controlBrowser.mockResolvedValueOnce({ status: "unknown" } as never);
  expect((await call({ deviceId: id, op: "input", token, action: { type: "click", x: 1, y: 2 } })).body).toEqual({ message: "computer_input_unconfirmed" });
  expect(devices.controlBrowser).toHaveBeenCalledTimes(2);
  // Without a source the desktop is taken over, as before.
  await call({ deviceId: id, op: "release", token });
  await call({ deviceId: id, op: "acquire" });
  expect(devices.acquireControl).toHaveBeenLastCalledWith(id, "desktop");
});
it("reports unknown effects without retrying an input", async () => {
  const { call, devices } = setup();
  await call({ deviceId: id, op: "acquire" });
  devices.controlInput.mockResolvedValue({ status: "unknown" } as never);
  expect((await call({ deviceId: id, op: "input", token, action: { type: "text", text: "private" } })).body).toEqual({ message: "computer_input_unconfirmed" });
  expect(devices.controlInput).toHaveBeenCalledTimes(1);
});
it("pastes into the focused app and forwards double-click and drag using the shipped driver schema", async () => {
  const { call, devices } = setup();
  await call({ deviceId: id, op: "acquire" });
  const input = (action: unknown) => call({ deviceId: id, op: "input", token, action });
  expect((await input({ type: "text", text: "中文" })).status).toBe(200);
  expect(devices.controlInput).toHaveBeenLastCalledWith(
    id,
    token,
    {
      tool: "sequence",
      args: {
        actions: [
          { tool: "clipboard_set", args: { text: "中文" } },
          { tool: "press", args: { combo: "ctrl+v" } },
        ],
      },
    },
    expect.any(AbortSignal),
  );
  await input({ type: "click", x: 10, y: 20, count: 2 });
  expect(devices.controlInput).toHaveBeenLastCalledWith(
    id,
    token,
    { tool: "mouse_click", args: { xy: "10,20", button: "left", count: 2 } },
    expect.any(AbortSignal),
  );
  await input({ type: "drag", x: 10, y: 20, toX: 30, toY: 40 });
  expect(devices.controlInput).toHaveBeenLastCalledWith(id, token, { tool: "drag", args: { from_xy: "10,20", to_xy: "30,40" } }, expect.any(AbortSignal));
  expect((await input({ type: "drag", x: 10, y: 20, toX: -1, toY: 40 })).status).toBe(400);
});
