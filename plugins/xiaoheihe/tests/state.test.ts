import { writeFileSync, unlinkSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountStore, dayKey } from "../src/store.js";
const directories: string[] = [];
const stores: AccountStore[] = [];
async function open() {
  const dir = await mkdtemp(join(tmpdir(), "xhh-state-"));
  directories.push(dir);
  const store = await AccountStore.open(dir, "account");
  stores.push(store);
  return { store, dir };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
describe("account state", () => {
  it("preserves pending replies, explicit skips, pagination and quota records across restart", async () => {
    const { store, dir } = await open();
    await store.reserve("sent-before", "interaction", 10, Date.now());
    await store.update((state) => {
      state.actions[0].status = "sent";
      state.replies = [
        { postId: "p", commentId: "c", rootId: "r", status: "pending", discoveredAt: 1, attempts: 2, lastAttemptAt: 2, scanCursor: "next" },
        { postId: "p", commentId: "skip", status: "skipped", discoveredAt: 1, attempts: 1, lastAttemptAt: 2 },
      ];
      state.notificationCursor = { boundary: "100", head: "200", offset: 60 };
    });
    await store.close();
    const reopened = await AccountStore.open(dir, "account");
    stores.push(reopened);
    expect(reopened.snapshot()).toMatchObject({
      paused: null,
      notificationCursor: { boundary: "100", head: "200", offset: 60 },
      replies: expect.arrayContaining([
        expect.objectContaining({ commentId: "c", status: "pending", scanCursor: "next" }),
        expect.objectContaining({ commentId: "skip", status: "skipped" }),
      ]),
      actions: [expect.objectContaining({ key: "sent-before", status: "sent" })],
    });
  });

  it("reads legacy state and persists only the latest 300 bounded activity records", async () => {
    const { store, dir } = await open();
    const legacy = store.snapshot();
    await store.close();
    delete (legacy as Partial<typeof legacy>).activities;
    delete (legacy as Partial<typeof legacy>).replies;
    delete (legacy as Partial<typeof legacy>).notificationCursor;
    delete (legacy as Partial<typeof legacy>).seenFeedPostIds;
    await writeFile(join(dir, "state.json"), JSON.stringify(legacy));
    const reopened = await AccountStore.open(dir, "account");
    stores.push(reopened);
    expect(reopened.snapshot().activities).toEqual([]);
    expect(reopened.snapshot().replies).toEqual([]);
    expect(reopened.snapshot().seenFeedPostIds).toEqual([]);
    expect(reopened.snapshot().notificationCursor).toEqual({ boundary: null, head: null, offset: 0 });
    await reopened.update((state) => {
      state.activities = Array.from({ length: 305 }, (_, index) => ({
        id: String(index),
        at: index,
        kind: "browse",
        outcome: "ok",
        source: "community:AI",
        count: 5,
      }));
    });
    await reopened.recordActivity({ kind: "read_post", outcome: "ok", title: "x".repeat(500), body: "do-not-store" } as never, 400);
    const data = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    expect(data.activities).toHaveLength(300);
    expect(data.activities[0].id).toBe("6");
    expect(data.activities.at(-1).title).toHaveLength(200);
    expect(data.activities.at(-1)).not.toHaveProperty("body");
    expect(data.actions).toEqual([]);
  });
  it("bounds and persists the feed seen ledger across restart without changing actions or cached ownership", async () => {
    const { store, dir } = await open();
    await store.update((state) => {
      state.seenFeedPostIds = [...Array.from({ length: 2010 }, (_, i) => String(i)), "2009"];
      state.watched["post:old"] = { ownPost: true, ownCommentIds: ["ours"], seen: ["reply"], touchedAt: 0 };
    });
    await store.close();
    const reopened = await AccountStore.open(dir, "account");
    stores.push(reopened);
    expect(reopened.snapshot().seenFeedPostIds).toHaveLength(2000);
    expect(reopened.snapshot().seenFeedPostIds[0]).toBe("10");
    expect(reopened.snapshot().seenFeedPostIds.at(-1)).toBe("2009");
    expect(reopened.snapshot().watched["post:old"].ownCommentIds).toEqual(["ours"]);
    expect(reopened.snapshot().actions).toEqual([]);
  });

  it("uses a Shanghai calendar day", () => {
    expect(dayKey(Date.parse("2026-10-26T15:59:59Z"))).toBe("2026-10-26");
    expect(dayKey(Date.parse("2026-10-26T16:00:00Z"))).toBe("2026-10-27");
  });
  it("persists owner-only state and refuses a second owner", async () => {
    const { store, dir } = await open();
    await store.update((s) => {
      s.paused = "operator";
    });
    expect((await stat(join(dir, "state.json"))).mode & 0o777).toBe(0o600);
    await expect(AccountStore.open(dir, "account")).rejects.toThrow();
    await store.close();
    const other = await AccountStore.open(dir, "account");
    stores.push(other);
    expect(other.snapshot().paused).toBe("operator");
  });
  it("serializes concurrent quota reservations and does not refund uncertain sends", async () => {
    const { store } = await open();
    const now = Date.parse("2026-10-26T10:00:00Z");
    const results = await Promise.allSettled([store.reserve("a", "post", 1, now), store.reserve("b", "post", 1, now)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await store.update((state) => {
      state.actions[0]!.status = "sent";
    });
    await expect(store.reserve("c", "post", 1, now)).rejects.toThrow("daily_limit");
    await expect(store.reserve("a", "post", 1, now + 86400000)).rejects.toThrow("duplicate_action");
    await store.reserve("d", "post", 1, now + 86400000);
  });
  it("zero disables writes; interrupted sends pause on restart", async () => {
    const { store, dir } = await open();
    await expect(store.reserve("no", "interaction", 0, Date.now())).rejects.toThrow("daily_limit");
    await store.reserve("maybe", "interaction", 10, Date.now());
    await store.close();
    const other = await AccountStore.open(dir, "account");
    stores.push(other);
    expect(other.snapshot().paused).toBe("uncertain_delivery");
    expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8")).actions[0].status).toBe("uncertain");
  });

  it("opens canonical maintenance state under lock without changing the ledger", async () => {
    const { store, dir } = await open();
    await store.update((state) => {
      state.actions.push({ key: "uncertain", kind: "interaction", day: "old", at: 1, status: "uncertain", target: "post:account:p" });
    });
    await store.close();
    const before = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    const guarded = await AccountStore.open(dir, "account", { preserveState: true });
    stores.push(guarded);
    expect(guarded.snapshot()).toEqual(before);
    await guarded.update((state) => {
      state.paused = "uncertain_delivery";
    });
    expect(guarded.snapshot().actions).toEqual(before.actions);
  });

  it.each(["pending", "unknown", "defaults", "reply-trim"])("refuses %s maintenance normalization before any state write", async (variant) => {
    const { store, dir } = await open();
    await store.close();
    const raw = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    if (variant === "pending") raw.actions.push({ key: "in-flight", kind: "interaction", day: "old", at: 1, status: "pending", target: "post:account:p" });
    if (variant === "unknown") raw.extra = "preserve me";
    if (variant === "defaults") delete raw.seenFeedPostIds;
    if (variant === "reply-trim")
      raw.replies = Array.from({ length: 2001 }, (_, i) => ({
        postId: "p",
        commentId: String(i),
        status: "replied",
        discoveredAt: 1,
        attempts: 1,
        lastAttemptAt: 1,
      }));
    const before = JSON.stringify(raw);
    await writeFile(join(dir, "state.json"), before);
    await expect(AccountStore.open(dir, "account", { preserveState: true })).rejects.toThrow("account_state_guard_failed");
    expect(await readFile(join(dir, "state.json"), "utf8")).toBe(before);
    await expect(stat(join(dir, "owner.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("owner lock recovery", () => {
  async function locked(value: string) {
    const dir = await mkdtemp(join(tmpdir(), "xhh-owner-"));
    directories.push(dir);
    await writeFile(join(dir, "owner.lock"), value, { mode: 0o600 });
    return dir;
  }
  it("recovers a proven dead legacy owner and removes the lock on normal close", async () => {
    const dir = await locked(JSON.stringify({ pid: 123456 }));
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    });
    const store = await AccountStore.open(dir, "account");
    stores.push(store);
    expect(JSON.parse(await readFile(join(dir, "owner.lock"), "utf8")).pid).toBe(process.pid);
    await store.close();
    await expect(stat(join(dir, "owner.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(dir, "owner.recovery.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([undefined, "EPERM", "EACCES"])("keeps live or inaccessible legacy owners closed (%s)", async (code) => {
    const original = JSON.stringify({ pid: process.pid });
    const dir = await locked(original);
    vi.spyOn(process, "kill").mockImplementation(() => {
      if (code) throw Object.assign(new Error("inaccessible"), { code });
      return true;
    });
    await expect(AccountStore.open(dir, "account")).rejects.toThrow("account_store_owned");
    expect(await readFile(join(dir, "owner.lock"), "utf8")).toBe(original);
  });
  it.each([
    "broken",
    "{}",
    '{"pid":0}',
    '{"pid":-1}',
    '{"pid":"123"}',
    '{"pid":1.5}',
    '{"pid":123,"identity":"bad"}',
    '{"pid":123,"identity":"------------------------------------:1"}',
  ])("refuses malformed owner %s", async (value) => {
    const dir = await locked(value);
    const kill = vi.spyOn(process, "kill");
    await expect(AccountStore.open(dir, "account")).rejects.toThrow();
    expect(kill).not.toHaveBeenCalled();
    expect(await readFile(join(dir, "owner.lock"), "utf8")).toBe(value);
  });
  it("never removes an owner lock replaced during its liveness check", async () => {
    const dir = await locked('{"pid":123456}');
    const path = join(dir, "owner.lock");
    const replacement = JSON.stringify({ pid: process.pid });
    vi.spyOn(process, "kill").mockImplementation(() => {
      unlinkSync(path);
      writeFileSync(path, replacement);
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    });
    await expect(AccountStore.open(dir, "account")).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(replacement);
  });
  it("never removes an owner lock edited during its liveness check", async () => {
    const dir = await locked('{"pid":123456}');
    const path = join(dir, "owner.lock");
    const replacement = JSON.stringify({ pid: process.pid, extra: "changed" });
    vi.spyOn(process, "kill").mockImplementation(() => {
      writeFileSync(path, replacement);
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    });
    await expect(AccountStore.open(dir, "account")).rejects.toThrow("account_store_lock_changed");
    expect(await readFile(path, "utf8")).toBe(replacement);
  });
  it("allows only one simultaneous stale-lock reclaimer", async () => {
    const dir = await locked('{"pid":123456}');
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    });
    const results = await Promise.allSettled([AccountStore.open(dir, "account"), AccountStore.open(dir, "account")]);
    const owners = results.filter((result): result is PromiseFulfilledResult<AccountStore> => result.status === "fulfilled");
    stores.push(...owners.map((result) => result.value));
    expect(owners).toHaveLength(1);
  });
  it("does not remove a replacement lock when closing its original owner", async () => {
    const { dir, store } = await open();
    const path = join(dir, "owner.lock");
    unlinkSync(path);
    writeFileSync(path, "replacement");
    await store.close();
    expect(await readFile(path, "utf8")).toBe("replacement");
  });
  it.skipIf(process.platform !== "linux")("recovers a reused Linux PID only when its recorded start identity differs", async () => {
    const { dir, store } = await open();
    const owner = JSON.parse(await readFile(join(dir, "owner.lock"), "utf8"));
    expect(owner.identity).toMatch(/^[0-9a-f-]{36}:\d+$/);
    await store.close();
    await writeFile(join(dir, "owner.lock"), JSON.stringify({ pid: process.pid, identity: owner.identity.replace(/:\d+$/, ":0") }));
    const recovered = await AccountStore.open(dir, "account");
    stores.push(recovered);
    expect(JSON.parse(await readFile(join(dir, "owner.lock"), "utf8")).identity).toBe(owner.identity);
  });
});
