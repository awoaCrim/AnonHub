import { renderToString } from "@vue/server-renderer";
import { expect, it, vi } from "vitest";
import { createSSRApp } from "vue";

import Usage from "../web/src/pages/Usage.vue";

const state = vi.hoisted(() => ({ role: "member", username: "alice", features: { accounts: true } }));
vi.mock("../web/src/context", () => ({ useSession: () => ({ state }) }));
vi.mock("../web/src/lib/use-topic", () => ({ useTopic: () => ({ data: undefined, unavailable: true }) }));
vi.mock("../web/src/lib/route-state", async () => {
  const { ref } = await import("vue");
  return { useRouteState: (_: string, value: unknown) => ref(value) };
});

it("shows the administrator's user table but never shows it to a member", async () => {
  state.role = "member";
  const member = await renderToString(createSSRApp(Usage));
  expect(member).not.toContain("按用户");
  expect(member).not.toContain("（自己）");
  state.role = "owner";
  const owner = await renderToString(createSSRApp(Usage));
  expect(owner).toContain("按用户");
  expect(owner).toContain("（自己）");
});
