import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeStateDb, configureStorage, systemClock } from "@yesimbot/foundation";
import { expect, it } from "vitest";

import { extension as memorizer } from "../../memorizer/src/index.js";
import { sqliteMemoryTable } from "../../memorizer/src/store/sqlite.js";
import type { AdminHttpContext } from "../src/admin-auth.js";
import { installMemory } from "../src/webui/memory.js";
import { fakeHost } from "./fixtures/fake-host.js";

interface MemoryHttp extends Pick<AdminHttpContext, "status" | "body" | "set" | "get"> {
  query: Record<string, string>;
}

type MemoryRoute = (http: MemoryHttp) => Promise<void>;

type MemoryList = { memories: unknown[] };

it("publishes the real memory extension service to sibling Console routes and removes it on stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-memory-service-"));
  // The memory table lives in the shared SQLite under the data root (convention 08).
  configureStorage({ dataRoot: root });
  const core = {
    config: {},
    identity: { tenantId: async () => "11111111-1111-4111-8111-111111111111" },
    agent: { use: () => () => {} },
    resource: { get: async () => ({}), use: () => () => {} },
    model: { resolveChatModel: () => ({ model: {} }), resolveAuxiliaryModel: () => ({ model: {} }) },
    conversation: {},
  };
  const ctx = fakeHost({ baseDir: root, yesimbot: core });
  // What a host does with an extension: `provide` publishes a service by name, stopping the extension takes it away.
  const startMemorizer = async () => {
    const undo = (await memorizer.start({
      config: memorizer.parse({}),
      core,
      baseDir: root,
      clock: systemClock(),
      setTimeout: () => () => {},
      setInterval: () => () => {},
      on: () => () => {},
      provide: (name: string, service: object) => ctx.services.set(name, service),
      isOwnerContext: () => false,
    } as never)) as () => Promise<void>;
    return async () => {
      await undo();
      ctx.services.delete("yesimbotMemory");
    };
  };
  const routes = new Map<string, MemoryRoute>();
  Object.assign(ctx.server, {
    get: (path: string, handler: MemoryRoute) => routes.set("get" + path, handler),
    post: (path: string, handler: MemoryRoute) => routes.set("post" + path, handler),
  });
  const session = { role: "owner" };
  const auth = { sessionFromCookie: () => session, sameOrigin: () => true };
  installMemory(ctx, auth as never);
  const call = async () => {
    const http: MemoryHttp = { query: {}, set() {}, get: () => "", status: 200, body: undefined };
    await routes.get("get/yesimbot/api/v1/memory")!(http);
    return http;
  };
  let stopAgain: (() => Promise<void>) | undefined;
  try {
    expect((await call()).status).toBe(503);
    const stop = await startMemorizer();
    expect(ctx.get("yesimbotMemory")).toBeDefined();
    const now = Date.now();
    await sqliteMemoryTable().create({
      id: "retained-memory",
      type: "preference",
      content: "prefers concise answers",
      scope: "user",
      tenantId: "11111111-1111-4111-8111-111111111111",
      visibility: "owner",
      revision: 1,
      platform: "web",
      userId: "owner",
      selfId: "web-bot",
      channelId: "owner",
      channelType: "direct",
      importance: 1,
      confidence: 1,
      tags: [],
      status: "active",
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      guildId: null,
      forgottenAt: null,
      embedding: null,
      embeddingModel: null,
    });
    const listed = await call();
    expect(listed.status).toBe(200);
    expect((listed.body as MemoryList).memories).toEqual([
      expect.objectContaining({ id: "retained-memory", content: "prefers concise answers", visibility: "owner", revision: 1 }),
    ]);
    await stop();
    expect(ctx.get("yesimbotMemory")).toBeUndefined();
    expect((await call()).status).toBe(503);
    stopAgain = await startMemorizer();
    expect(ctx.get("yesimbotMemory")).toBeDefined();
    expect(((await call()).body as MemoryList).memories).toEqual((listed.body as MemoryList).memories);
  } finally {
    await stopAgain?.();
    closeStateDb();
    await rm(root, { recursive: true, force: true });
  }
});
