import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentWechatError } from "@yesimbot/wechat-transport";
import { expect, it, vi } from "vitest";

import { WechatLoginGateway } from "../src/wechat-login";

const loggedOut = { id: "account-1", alias: "bot", ownUsername: null, authenticated: false, connection: "disconnected" };

async function harness(accounts: unknown[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "wechat-login-"));
  const operation = {
    id: "op_1",
    accountId: "account-1",
    kind: "login",
    state: "awaiting_scan",
    result: { qrGeneration: 2, qrAvailable: true, lanChallenge: null },
  };
  const api = {
    findAccount: vi.fn(async () => accounts[0]),
    createAccount: vi.fn(async () => {
      accounts.push(loggedOut);
      return { id: "account-1" };
    }),
    login: vi.fn(async () => operation),
    operation: vi.fn(async () => operation),
    qr: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    cancelOperation: vi.fn(async () => ({ ...operation, state: "cancelled" })),
    logout: vi.fn(async () => ({ ...operation, kind: "logout" })),
  };
  const file = join(directory, "wechat-login.json");
  return { gateway: new WechatLoginGateway(api as never, "bot", file), api, operation, file };
}

it("creates the daemon account on the first login and shows its QR code by generation", async () => {
  const { gateway, api, file } = await harness();
  const status = await gateway.start();
  expect(api.createAccount).toHaveBeenCalledWith("bot");
  expect(api.login).toHaveBeenCalledWith("account-1", expect.stringMatching(/^yesimbot-login:/));
  expect(status).toEqual({ available: true, loggedIn: false, online: false, login: { state: "awaiting_scan", qrGeneration: 2 } });
  // Remembered across console restarts: the daemon cannot list running logins.
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ operation: "op_1" });
  expect(await gateway.qr(2)).toEqual({ image: "data:image/png;base64,iVBORw==", generation: 2 });
  expect(await gateway.qr(1)).toBeUndefined();
  // A waiting login is reused, not replaced.
  await gateway.start();
  expect(api.login).toHaveBeenCalledTimes(1);
});

it("reports a logged-in account and why a login ended", async () => {
  const { gateway, operation } = await harness([{ ...loggedOut, ownUsername: "wxid_self", authenticated: true, connection: "online" }]);
  expect(await gateway.status()).toEqual({ available: true, loggedIn: true, online: true, accountId: "wxid_self" });
  const ended = await harness([loggedOut]);
  await ended.gateway.start();
  Object.assign(ended.operation, { state: "failed", result: { code: "login_lan_challenge_failed" } });
  expect((await ended.gateway.status()).login).toEqual({ state: "failed", problem: "lan" });
  Object.assign(ended.operation, { state: "rejected", result: {} });
  expect((await ended.gateway.status()).login).toEqual({ state: "rejected", problem: "rejected" });
  void operation;
});

it("treats an unreachable daemon as unavailable and forgets logins it no longer knows", async () => {
  const { gateway, api, file } = await harness([loggedOut]);
  await gateway.start();
  api.operation.mockRejectedValueOnce(new AgentWechatError(404, "not_found"));
  expect((await gateway.status()).login).toBeUndefined();
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({});
  api.findAccount.mockRejectedValueOnce(new TypeError("fetch failed"));
  expect(await gateway.status()).toEqual({ available: false, loggedIn: false, online: false });
});
