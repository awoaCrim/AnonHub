import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { systemClock } from "@yesimbot/foundation";
import { NapCatGateway } from "@yesimbot/onebot/napcat";
import { describe, expect, it, vi } from "vitest";

import { buildPanelPayload } from "../src/panel-source.js";
import { QQPresence } from "../src/qq-presence.js";
import { platformSummary, platformTone, presentPlatforms } from "../web/src/pages/platforms-model.js";

const Status = { OFFLINE: 0, ONLINE: 1, CONNECT: 2, DISCONNECT: 3 } as const;

// 2026-11-23: NapCat kept its OneBot link up while QQ itself was kicked offline for hours, and 平台 stayed green.

function context(selfId = "3535802886") {
  return {
    clock: systemClock(),
    loader: { config: { plugins: { "group:yesimbot": { "adapter-onebot:qq": { selfId } } } } },
    bots: [{ platform: "onebot", selfId, status: Status.ONLINE }],
    yesimbot: {
      model: {
        listProviders: () => [],
        listChatModels: () => [],
        listEmbeddingModels: () => [],
        getDefaultChatModelId: () => undefined,
        getDefaultEmbeddingModelId: () => undefined,
      },
    },
  };
}

describe("QQ presence from NapCat", () => {
  it("marks a connected QQ offline when NapCat says its account is offline, and online again once it is back", () => {
    const presence = new QQPresence();
    const state = () => buildPanelPayload(context() as never, [], presence).adapters[0]!.state;
    expect(state()).toBe("online");
    presence.update({ offline: true, accountId: "3535802886" });
    expect(state()).toBe("offline");
    // Another account's report, or no number at all, decides only for its own account / the single NapCat account.
    presence.update({ offline: true, accountId: "10001" });
    expect(state()).toBe("online");
    presence.update({ offline: true });
    expect(state()).toBe("offline");
    // An unreadable login service keeps the last answer instead of flipping to online.
    presence.update(undefined);
    expect(state()).toBe("offline");
    presence.update({ offline: false });
    expect(state()).toBe("online");
  });

  it("still counts an offline QQ as a connected platform for setup", () => {
    const presence = new QQPresence();
    presence.update({ offline: true, accountId: "3535802886" });
    const payload = buildPanelPayload(context() as never, [], presence);
    expect(payload.onboarding.steps.find((step) => step.id === "adapter")?.done).toBe(true);
  });

  it("shows an offline QQ as 离线 in danger tone", () => {
    const presence = new QQPresence();
    presence.update({ offline: true });
    const panel = buildPanelPayload(context() as never, [], presence);
    const platforms = presentPlatforms(panel, [], { napcat: true });
    expect(platformSummary(platforms)).toEqual({ tone: "danger", label: "QQ 离线" });
    expect(platformTone("offline")).toBe("danger");
  });

  it("asks NapCat only for the login state, never for a QR code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "napcat-presence-"));
    const path = join(dir, "webui.json");
    try {
      await writeFile(path, JSON.stringify({ token: "private-secret" }));
      const response = (data: unknown) => ({ ok: true, json: async () => ({ code: 0, data }) });
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(response({ Credential: "private-token" }))
        .mockResolvedValueOnce(response({ isLogin: false, isOffline: true }))
        .mockResolvedValueOnce(response({ uin: "3535802886", nick: "anon" }))
        .mockResolvedValueOnce(response({ isLogin: false, isOffline: false, qrcodeurl: "" }));
      const gateway = new NapCatGateway({ endpoint: "http://127.0.0.1:6099", webuiConfigFile: path }, fetcher);
      expect(await gateway.presence()).toEqual({ offline: true, accountId: "3535802886" });
      expect(await gateway.presence()).toEqual({ offline: false });
      expect(fetcher.mock.calls.map((call) => String(call[0]).replace("http://127.0.0.1:6099/api/", ""))).toEqual([
        "auth/login",
        "QQLogin/CheckLoginStatus",
        "QQLogin/GetQQLoginInfo",
        "QQLogin/CheckLoginStatus",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
