import { renderToString } from "@vue/server-renderer";
import { expect, it } from "vitest";
import { createSSRApp, h } from "vue";

import type { TopicState } from "../web/src/lib/live";
import { connectionNoticeKey } from "../web/src/shell/connection-notice";
import TopicFeedback from "../web/src/shell/TopicFeedback.vue";

const stale: TopicState = { data: { ok: true }, revision: 1, stale: true, cached: false, failed: false, unavailable: false };

async function render(state: TopicState, inShell: boolean) {
  const app = createSSRApp({ render: () => h(TopicFeedback, { state, label: "回复偏好" }) });
  if (inShell) app.provide(connectionNoticeKey, true);
  return renderToString(app);
}

// User, 2026-11-17: a page showed the disconnect notice once at the top and again above every block.
it("leaves the disconnect notice to the app shell's single banner", async () => {
  expect(await render(stale, true)).not.toContain("连接中断");
  // Pages without the shell (the setup wizard) still say it once themselves.
  expect(await render(stale, false)).toContain("连接中断");
  // Failures and loading are about that block, so they stay.
  expect(await render({ ...stale, failed: true }, true)).toContain("回复偏好更新失败");
  expect(await render({ ...stale, data: undefined }, true)).toContain("正在读取回复偏好");
});
