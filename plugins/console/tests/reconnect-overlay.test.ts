import { readFileSync } from "node:fs";

import { renderToString } from "@vue/server-renderer";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSSRApp, effectScope, h, ref } from "vue";

import { delayedFlag } from "../web/src/shell/delayed-flag";
import ReconnectOverlay from "../web/src/shell/ReconnectOverlay.vue";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// User, 2026-11-18: 「连接中断的提醒能不能改成全屏加载？动态的，最好是半透明的，或者静默加载。」
test("a short drop stays silent; a longer one shows the loading layer until the stream is back", () => {
  const scope = effectScope();
  const reconnecting = ref(false);
  const shown = scope.run(() => delayedFlag(() => reconnecting.value, 1000))!;
  reconnecting.value = true;
  vi.advanceTimersByTime(900);
  expect(shown.value).toBe(false);
  reconnecting.value = false;
  vi.advanceTimersByTime(1000);
  expect(shown.value).toBe(false);

  reconnecting.value = true;
  vi.advanceTimersByTime(1000);
  expect(shown.value).toBe(true);
  reconnecting.value = false;
  expect(shown.value).toBe(false);
  reconnecting.value = true;
  scope.stop();
  vi.advanceTimersByTime(2000);
  expect(shown.value).toBe(false);
});

test("the shell shows its disconnect state only as the full-screen layer", async () => {
  const shell = readFileSync(new URL("../web/src/shell/AppShell.vue", import.meta.url), "utf8");
  expect(shell).toContain('<ReconnectOverlay :reconnecting="reconnecting" />');
  expect(shell).not.toContain("连接中断，正在重连");
  // Nothing is shown at first paint, even while already reconnecting.
  expect(await renderToString(createSSRApp({ render: () => h(ReconnectOverlay, { reconnecting: true }) }))).not.toContain("正在重新连接");
});
