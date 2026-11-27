import { expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";

import { expandedCodec, historyReturnTo, historySessions, pageCodec } from "../web/src/lib/history-navigation";

it("makes every historical session reachable and preserves UTC filename order without mutating the index", () => {
  const sessions = Array.from({ length: 19 }, (_, i) => ({ filename: `202610${String(i + 1).padStart(2, "0")}T023056Z.jsonl` })).reverse();
  const original = [...sessions];
  expect(historySessions(sessions, false)).toHaveLength(4);
  expect(historySessions(sessions, true).map((session) => session.filename)).toEqual(original.map((session) => session.filename));
  expect(sessions).toEqual(original);
  expect(historySessions(sessions, true)).toContain(sessions[18]);
});

it("retains a list's encoded search, page and expanded channels through detail and browser back", async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/conversations", component: {} },
      { path: "/conversations/:channel/:session", component: {} },
    ],
  });
  const list = { path: "/conversations", query: { q: "群 / 频道", page: "2", expanded: expandedCodec.serialize(["qq:a,b/群"]) } };
  await router.push(list);
  const original = router.currentRoute.value.fullPath;
  await router.push({ path: "/conversations/qq/20261029T023056Z.jsonl", query: { returnTo: original } });
  expect(historyReturnTo(router.currentRoute.value.query.returnTo, "/conversations")).toBe(original);
  const navigation = new Promise<void>((resolve) => {
    const remove = router.afterEach(() => {
      remove();
      resolve();
    });
  });
  router.back();
  await navigation;
  expect(router.currentRoute.value.fullPath).toBe(original);
  expect(expandedCodec.parse(String(router.currentRoute.value.query.expanded))).toEqual(["qq:a,b/群"]);
});

it("rejects unrelated or external return targets and malformed pagination", () => {
  for (const value of [
    "//evil.test/conversations",
    "https://evil.test/conversations",
    "/xiaoheihe?q=a",
    "/conversations/abc",
    "/conversations?x=1#bad",
    ["/conversations"],
  ]) {
    expect(historyReturnTo(value, "/conversations")).toBe("/conversations");
  }
  for (const raw of ["0", "-1", "1.2", "Infinity", "9007199254740993"]) expect(pageCodec.parse(raw)).toBeUndefined();
  expect(pageCodec.parse("3")).toBe(3);
  expect(expandedCodec.parse("invalid")).toBeUndefined();
});
