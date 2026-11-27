import { expect, it, vi } from "vitest";

import { createAccountsState } from "../web/src/state/accounts-state";

const account = (plugins: string[]) => ({ id: "friend", username: "friend", plugins });

it("saves a friend's granted features and reports whether the server kept them", async () => {
  const request = vi.fn(async (_path: string, body?: { plugins: string[] }) => ({ account: account(body!.plugins) }));
  const view = createAccountsState(request as never);
  view.state.accounts = [account(["search"]) as never];
  expect(await view.savePlugins("friend", ["search", "memory"])).toBe(true);
  expect(request).toHaveBeenLastCalledWith("admin/accounts/friend/plugins", { plugins: ["search", "memory"] });
  expect(view.state.accounts[0]!.plugins).toEqual(["search", "memory"]);
  expect(view.state.notice).toBe("");

  request.mockResolvedValueOnce({ account: account(["search"]), message: "runtime_policy_sync_failed" } as never);
  expect(await view.savePlugins("friend", ["search"])).toBe(true);
  expect(view.state.notice).toContain("下次启动时生效");

  request.mockRejectedValueOnce(new Error("offline"));
  expect(await view.savePlugins("friend", [])).toBe(false);
  expect(view.state.accounts[0]!.plugins).toEqual(["search"]);
  expect(view.state.error).not.toBe("");
});
