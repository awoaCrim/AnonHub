import { systemClock } from "@yesimbot/foundation";
import { afterEach, expect, it, vi } from "vitest";

import { ConfigStore } from "../src/config/store.js";
import { REQUIRED_MEMBER_PLUGINS } from "../src/shared/plugin-catalog.js";
import type { WebUIFeatures } from "../src/shared/webui.js";
import { BOOTSTRAP_PATH, FEATURES_PATH, installWebUI } from "../src/webui/index.js";

const disposers: Array<() => void> = [];
interface TestHttp {
  set(name: string, value: string): void;
  get(name: string): string;
  body?: { features: WebUIFeatures };
}
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
});

it("projects optional grants independently of plugin enablement and enforces usage topic access", () => {
  let allowed = new Set(REQUIRED_MEMBER_PLUGINS);
  vi.spyOn(ConfigStore.prototype, "allowed").mockImplementation(() => allowed);
  const routes = new Map<string, (http: TestHttp) => unknown>();
  const injections: Array<{ names: string[]; apply: (ctx: unknown) => unknown }> = [];
  const ctx = {
    onLog: () => () => {},
    baseDir: "/nonexistent",
    loader: { config: { plugins: {} } },
    clock: systemClock(),
    server: { get: (path: string, handler: (http: TestHttp) => unknown) => routes.set(path, handler), post: () => {} },
    logger: () => ({ warn: () => {} }),
    on: (name: string, handler: () => void) => {
      if (name === "dispose") disposers.push(handler);
    },
    inject: (names: string[], apply: (ctx: unknown) => unknown) => injections.push({ names, apply }),
    get: () => ({ snapshot: async () => ({}), subscribe: () => () => {} }),
  };
  const auth = { sessionFromCookie: () => ({ role: "owner" }), sameOrigin: () => true, onRevocation: () => () => {} };
  const { topics } = installWebUI(ctx as never, auth as never, { assetsDir: "/nonexistent", features: { napcat: true, accounts: false, tenant: true } });
  const call = (path: string) => {
    const http: TestHttp = { set: () => {}, get: () => "" };
    routes.get(path)!(http);
    return http.body!;
  };
  expect(call(BOOTSTRAP_PATH).features).toMatchObject({ usage: false, tenant: true });
  expect(call(FEATURES_PATH).features).toMatchObject({ usage: false });
  allowed = new Set([...REQUIRED_MEMBER_PLUGINS, "yesimbot-usage", "yesimbot-xiaoheihe"]);
  expect(call(FEATURES_PATH).features).toMatchObject({ usage: true });
  expect(call(FEATURES_PATH).features).not.toHaveProperty("xiaoheihe");
  expect(topics.get("usage")).toBeUndefined(); // Granted but disabled: the plugin page can enable it.
  injections.find((entry) => entry.names.includes("yesimbotUsage"))!.apply(ctx);
  expect(topics.get("usage")!.authorize({ role: "owner" } as never)).toBe(true);
  allowed = new Set(REQUIRED_MEMBER_PLUGINS);
  expect(topics.get("usage")!.authorize({ role: "owner" } as never)).toBe(false);
});
