import { expect, it, vi } from "vitest";
import { createMemoryHistory } from "vue-router";

import { editorRegistry } from "../web/src/lib/editor-guard";
import { createLiveClient } from "../web/src/lib/live";
import { createSession } from "../web/src/lib/session";
import { createAppRouter } from "../web/src/router";

class TestSource {
  readyState = 1;
  listeners = new Map<string, (event: MessageEvent | Event) => void>();
  addEventListener(type: string, listener: (event: MessageEvent | Event) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.readyState = 2;
  }
  emit(type: string, data = {}) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

it("preserves dropped data as stale, clears unavailable data, and ignores replaced streams", async () => {
  const sources: TestSource[] = [];
  const live = createLiveClient({
    createSource: () => {
      const source = new TestSource();
      sources.push(source);
      return source;
    },
  });
  const panel = live.use("panel");
  await Promise.resolve();
  sources[0].emit("snapshot", { topic: "panel", revision: 1, data: { count: 3 } });
  sources[0].emit("error");
  expect(panel.state.data).toEqual({ count: 3 });
  expect(panel.state.stale).toBe(true);
  sources[0].emit("unavailable", { topic: "panel" });
  expect(panel.state).toMatchObject({ data: undefined, revision: 0, unavailable: true, failed: false });
  sources[0].emit("snapshot", { topic: "panel", revision: 2, data: { count: 4 } });
  expect(panel.state.unavailable).toBe(false);
  const logs = live.use("logs");
  await Promise.resolve();
  sources[0].emit("unavailable", { topic: "panel" });
  sources[0].emit("topic-error", { topic: "panel" });
  expect(panel.state).toMatchObject({ data: { count: 4 }, unavailable: false, failed: false });
  sources[1].emit("topic-error", { topic: "panel" });
  expect(panel.state).toMatchObject({ stale: true, failed: true });
  panel.release();
  logs.release();
  live.stop();
});

it("clears member runtime, capabilities and identity on session invalidation", async () => {
  const fetcher = vi.fn(
    async (input: RequestInfo | URL) =>
      new Response(
        JSON.stringify(
          String(input).endsWith("bootstrap")
            ? {
                authenticated: true,
                session: { username: "member", role: "member", expiresAt: Date.now() + 60_000 },
                features: { accounts: true, napcat: false, tenant: false },
              }
            : String(input).endsWith("runtime")
              ? { runtime: { state: "running" } }
              : { features: { accounts: false, napcat: true, tenant: true } },
        ),
      ),
  ) as typeof fetch;
  const session = createSession(fetcher);
  await session.refresh();
  expect(session.state.memberRuntime).toBe("running");
  session.invalidate();
  expect(session.state).toMatchObject({
    authenticated: false,
    username: "",
    role: "owner",
    expiresAt: 0,
    memberRuntime: "",
    features: { accounts: false, napcat: false, tenant: false },
  });
  expect(session.ensure()).toBe(false);
});

it("keeps scroll for query edits, resets new pages and restores history positions", async () => {
  const session = createSession();
  Object.assign(session.state, { loaded: true, authenticated: true, expiresAt: Date.now() + 60_000 });
  const router = createAppRouter(session, createMemoryHistory(), [
    { path: "/models", component: {} },
    { path: "/plugins", component: {} },
  ]);
  await router.push("/models?connection=one");
  const from = router.currentRoute.value;
  await router.replace("/models?connection=two");
  const behavior = router.options.scrollBehavior!;
  expect(await behavior(router.currentRoute.value, from, null)).toBe(false);
  const saved = { left: 0, top: 540 };
  expect(await behavior(router.currentRoute.value, from, saved)).toEqual(saved);
  const previous = router.currentRoute.value;
  await router.push("/plugins");
  expect(await behavior(router.currentRoute.value, previous, null)).toEqual({ top: 0 });
});

it("keeps model draft navigation inside the editor while still guarding an actual page change", async () => {
  const session = createSession();
  Object.assign(session.state, { loaded: true, authenticated: true, expiresAt: Date.now() + 60_000 });
  const router = createAppRouter(session, createMemoryHistory(), [
    { path: "/settings/models", name: "settings-models", component: {} },
    { path: "/settings/platforms", component: {} },
  ]);
  await router.push("/settings/models?connection=demo&tab=chat");
  const leave = vi.spyOn(editorRegistry, "leave").mockResolvedValue(false);
  try {
    await router.replace("/settings/models?connection=demo&tab=embedding");
    expect(router.currentRoute.value.query.tab).toBe("embedding");
    await router.replace("/settings/models?connection=new:1&tab=connection");
    expect(router.currentRoute.value.query.connection).toBe("new:1");
    expect(leave).not.toHaveBeenCalled();
    await router.push("/settings/platforms");
    expect(leave).toHaveBeenCalledOnce();
    expect(router.currentRoute.value.path).toBe("/settings/models");
  } finally {
    leave.mockRestore();
  }
});
