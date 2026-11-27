import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig, systemClock } from "@yesimbot/foundation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeApi = {
  login: vi.fn(async () => ({ userId: "bot" })),
  emojis: vi.fn(async () => Promise.reject(new Error("no catalog"))),
  feed: vi.fn(async () => []),
  community: vi.fn(async () => []),
  findCommunities: vi.fn(async () => []),
  search: vi.fn(async () => []),
  post: vi.fn(),
  thread: vi.fn(),
  publish: vi.fn(),
  comment: vi.fn(),
  close: vi.fn(async () => {}),
};
const qr = { states: [] as Record<string, unknown>[] };
vi.mock("../src/client.js", async (original) => ({ ...(await original<typeof import("../src/client.js")>()), createXiaoheiheApi: () => fakeApi }));
vi.mock("../src/heybox/http.js", async (original) => {
  const actual = await original<typeof import("../src/heybox/http.js")>();
  class FakeHttp {
    request = vi.fn(async (path: string) => {
      if (path === "/account/get_qrcode_url/") return { result: { qr_url: "https://www.xiaoheihe.cn/login?qr=token-1" } };
      return qr.states.shift() ?? { result: { error: "wait" } };
    });
    cookies = () => [
      { name: "user_heybox_id", value: "bot", domain: ".xiaoheihe.cn" },
      { name: "user_pkey", value: "key", domain: ".xiaoheihe.cn" },
    ];
  }
  return { ...actual, HeyboxHttp: FakeHttp };
});

import { extension, moduleConfig } from "../src/index.js";
import { XiaoheiheService } from "../src/service.js";

let baseDir: string;
const dataDir = () => join(baseDir, "data", "yesimbot", "xiaoheihe", "bot");
const config = parseConfig(moduleConfig, { selfId: "bot" });
const saveStoredSession = async (userId = "bot") => {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(
    join(dataDir(), "session.json"),
    JSON.stringify({ user_id: userId, cookies: [{ name: "user_pkey", value: "key", domain: ".xiaoheihe.cn" }] }),
  );
};

const realSetTimeout = setTimeout;
/** Advances the fake clock in steps, letting real file and PNG work finish between them. */
async function until(done: () => boolean) {
  for (let step = 0; step < 400 && !done(); step++) {
    await vi.advanceTimersByTimeAsync(500);
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
}

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "xhh-service-"));
  vi.clearAllMocks();
  fakeApi.login.mockResolvedValue({ userId: "bot" });
  qr.states = [];
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(baseDir, { recursive: true, force: true });
});

describe("login service", () => {
  it("reports a missing login without creating files or throwing", async () => {
    const service = new XiaoheiheService({ baseDir }, config);
    await service.connect();
    expect(service.status()).toMatchObject({ selfId: "bot", state: "login_required", paused: null, login: { state: "idle" } });
    expect(() => service.requireAccount()).toThrow("xiaoheihe_login_required");
    await expect(access(dataDir())).rejects.toThrow();
    await service.stop();
  });

  it("connects with the stored session and old state, and starts nothing on its own", async () => {
    vi.useFakeTimers();
    await saveStoredSession();
    await mkdir(dataDir(), { recursive: true });
    const legacy = {
      version: 1,
      accountId: "bot",
      paused: null,
      actions: [],
      watched: { "post:9": { seen: ["1"], ownCommentIds: [], ownPost: false, touchedAt: 1 } },
      pendingVisits: [],
      lastBrowseAt: 5,
      seenFeedPostIds: ["old-1"],
      commentedPostIds: ["old-2"],
    };
    await writeFile(join(dataDir(), "state.json"), JSON.stringify(legacy));
    const service = new XiaoheiheService({ baseDir }, config);
    await service.connect();
    expect(service.status()).toMatchObject({ state: "connected", postsRemaining: 1, interactionsRemaining: 10 });
    expect(service.requireAccount()).toBe(service.account);
    // No polling, no rounds: no timer is pending and no browsing request was made.
    expect(vi.getTimerCount()).toBe(0);
    expect(fakeApi.feed).not.toHaveBeenCalled();
    const stored = JSON.parse(await readFile(join(dataDir(), "state.json"), "utf8"));
    expect(stored).toMatchObject({ accountId: "bot", seenFeedPostIds: ["old-1"], commentedPostIds: ["old-2"], lastBrowseAt: 5 });
    expect(stored.watched["post:9"]).toBeDefined();
    await service.stop();
    await expect(access(join(dataDir(), "owner.lock"))).rejects.toThrow();
    expect(service.account).toBeUndefined();
  });

  it("lifts an old authentication pause once a fresh session proves the login", async () => {
    await saveStoredSession();
    await mkdir(dataDir(), { recursive: true });
    await writeFile(
      join(dataDir(), "state.json"),
      JSON.stringify({ version: 1, accountId: "bot", paused: "authentication_required", actions: [], watched: {}, pendingVisits: [], lastBrowseAt: 0 }),
    );
    const service = new XiaoheiheService({ baseDir }, config);
    await service.connect();
    expect(service.status()).toMatchObject({ state: "connected", paused: null });
    await service.stop();
  });

  it("refuses a session of another account and a rejected session", async () => {
    await saveStoredSession("someone-else");
    const mismatch = new XiaoheiheService({ baseDir }, config);
    await mismatch.connect();
    expect(mismatch.status().state).toBe("error");
    expect(() => mismatch.requireAccount()).toThrow("xiaoheihe_login_required");
    await saveStoredSession();
    fakeApi.login.mockRejectedValue(new Error("authentication_required"));
    const rejected = new XiaoheiheService({ baseDir }, config);
    await rejected.connect();
    expect(rejected.account).toBeUndefined();
    expect(["login_required", "error"]).toContain(rejected.status().state);
    await mismatch.stop();
    await rejected.stop();
  });

  it("scans a QR code, saves the session and connects without a restart", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const service = new XiaoheiheService({ baseDir }, config);
    await service.connect();
    expect(service.status().state).toBe("login_required");
    await service.startWebLogin();
    await service.startWebLogin();
    expect(service.status().login.state).toBe("pending");
    await until(() => service.status().login.image !== undefined);
    expect(service.status().login.image).toMatch(/^data:image\/png;base64,/);
    qr.states = [{ result: { error: "wait" } }, { result: { error: "ok", profile: { heybox_id: "bot" }, pkey: "key" } }];
    await until(() => service.status().login.state === "finished");
    expect(service.status()).toMatchObject({ state: "connected", login: { state: "finished", message: "小黑盒登录成功" } });
    const saved = JSON.parse(await readFile(join(dataDir(), "session.json"), "utf8"));
    expect(saved.user_id).toBe("bot");
    expect(JSON.stringify(service.status())).not.toContain("key");
    await service.stop();
  });

  it("does not save a QR login of another account", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const service = new XiaoheiheService({ baseDir }, config);
    await service.connect();
    await service.startWebLogin();
    qr.states = [{ result: { error: "ok", profile: { heybox_id: "stranger" } } }];
    await until(() => service.status().login.state === "finished");
    expect(service.status().login).toMatchObject({ state: "finished" });
    expect(service.status().login.message).toContain("不一致");
    expect(service.status().state).toBe("login_required");
    await expect(access(join(dataDir(), "session.json"))).rejects.toThrow();
    await service.stop();
  });
});

describe("extension wiring", () => {
  it("registers one service and one agent plugin for every conversation, connects on start and undoes both on stop", async () => {
    const provided: Record<string, unknown> = {};
    const unregisterTools = vi.fn();
    let registration: { id: string; claims?: unknown; setup: (scope: object, bot: object) => Promise<{ tools?: { name: string }[] } | null> } | undefined;
    const ctx = {
      config: extension.parse(config),
      baseDir,
      clock: systemClock(),
      provide: (key: string, value: unknown) => {
        provided[key] = value;
      },
      core: {
        agent: {
          use: (value: typeof registration) => {
            registration = value;
            return unregisterTools;
          },
        },
        identity: {
          conversation: async (scope: { platform: string; type: string }) => ({ platform: scope.platform, kind: scope.type === "direct" ? "direct" : "group" }),
        },
        resource: { get: async () => ({ assets: { put: async () => "id" } }) },
      },
    };
    const undo = (await extension.start(ctx as never)) as () => Promise<void>;
    expect(moduleConfig.id).toBe("yesimbot-xiaoheihe");
    expect(Object.keys(provided)).toEqual(["yesimbotXiaoheihe"]);
    expect(registration).toMatchObject({ id: "yesimbot-xiaoheihe" });
    expect(registration!.claims).toBeUndefined();
    const group = await registration!.setup({ type: "guild", platform: "onebot", channelId: "g", guildId: "g" }, { selfId: "1" });
    expect(group!.tools!.map((tool) => tool.name)).toContain("xiaoheihe_publish");
    expect(group!.tools!.map((tool) => tool.name)).toContain("xiaoheihe");
    const direct = await registration!.setup({ type: "direct", platform: "onebot", channelId: "private:2", selfId: "1", userId: "2" }, { selfId: "1" });
    expect(direct!.tools!.map((tool) => tool.name)).toContain("xiaoheihe_publish");
    expect((provided.yesimbotXiaoheihe as XiaoheiheService).status().state).toBe("login_required");
    await undo();
    expect(unregisterTools).toHaveBeenCalledOnce();
  });
});
