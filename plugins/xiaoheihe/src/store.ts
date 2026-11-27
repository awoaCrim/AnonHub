import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { AppError, contentHash, dayKey as dayOf, newId, systemClock, writeFileAtomic, type Clock } from "@yesimbot/foundation";
import { z } from "zod/v4";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);

const verificationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("comment"),
    postId: idSchema,
    contentHash: hashSchema,
    replyTarget: z.object({ id: idSchema, rootId: idSchema, authorId: idSchema, textHash: hashSchema }).optional(),
  }),
  z.object({ kind: z.literal("post"), contentHash: hashSchema, titleHash: hashSchema, topicIds: z.array(idSchema).max(100).optional() }),
]);

const actionSchema = z.object({
  key: z.string(),
  kind: z.enum(["post", "interaction"]),
  day: z.string(),
  at: z.number(),
  status: z.enum(["pending", "sent", "uncertain"]),
  target: z.string(),
  id: z.string().optional(),
  verification: verificationSchema.optional(),
});

const watchSchema = z.object({
  seen: z.array(z.string()),
  ownCommentIds: z.array(z.string()),
  ownPost: z.boolean(),
  ownRootIds: z.array(z.string()).optional(),
  floorPolls: z.record(z.string(), z.object({ cursor: z.string().optional(), at: z.number() })).optional(),
  lastFloorPollAt: z.number().optional(),
  touchedAt: z.number(),
});

const activitySchema = z
  .object({
    id: z.string().transform((value) => value.slice(0, 80)),
    at: z.number().finite().nonnegative(),
    kind: z.string().transform((value) => value.slice(0, 48)),
    outcome: z.enum(["ok", "failed", "blocked"]),
    postId: z
      .string()
      .transform((value) => value.slice(0, 80))
      .optional(),
    title: z
      .string()
      .transform((value) => value.slice(0, 200))
      .optional(),
    source: z
      .string()
      .transform((value) => value.slice(0, 200))
      .optional(),
    count: z.number().int().nonnegative().optional(),
    errorCode: z
      .string()
      .transform((value) => value.slice(0, 80))
      .optional(),
  })
  .strip();

const replySchema = z.object({
  postId: z.string().max(80),
  commentId: z.string().max(80),
  rootId: z.string().max(80).optional(),
  status: z.enum(["pending", "replied", "skipped", "uncertain"]),
  discoveredAt: z.number(),
  attempts: z.number().int().nonnegative(),
  lastAttemptAt: z.number(),
  scanCursor: z.string().max(80).optional(),
  errorCode: z.string().max(80).optional(),
});

/** The account's own recent publications, shown to browse rounds so it does not repeat itself. */
const recentCommentSchema = z.object({
  at: z.number(),
  postId: z.string().max(80),
  title: z
    .string()
    .transform((value) => value.slice(0, 120))
    .optional(),
  text: z.string().transform((value) => value.slice(0, 300)),
  reply: z.boolean().optional(),
});

/** Communities the Agent chose to browse, newest last. */
const recentCommunitySchema = z.object({
  id: z.string().max(80),
  name: z.string().transform((value) => value.slice(0, 100)),
  at: z.number(),
  visits: z.number().int().nonnegative(),
  /** Unseen posts the last visit returned; 0 tells the next round the community is drained. */
  lastCount: z.number().int().nonnegative().optional(),
});

/** Keywords the Agent searched lately, so a round does not repeat the same search. */
const recentSearchSchema = z.object({
  keyword: z.string().transform((value) => value.slice(0, 50)),
  at: z.number(),
  count: z.number().int().nonnegative(),
});

const stateSchema = z.object({
  version: z.literal(1),
  accountId: z.string(),
  paused: z.string().nullable(),
  actions: z.array(actionSchema),
  activities: z
    .array(activitySchema)
    .default([])
    .transform((items) => items.slice(-300)),
  watched: z.record(z.string(), watchSchema),
  pendingVisits: z.array(z.string()),
  lastBrowseAt: z.number(),
  seenFeedPostIds: z
    .array(z.string().max(80))
    .default([])
    .transform((ids) => [...new Set(ids)].slice(-2000)),
  replies: z.array(replySchema).default([]),
  /** Posts that already carry this account's top-level comment; one per post, 楼中楼 replies are not limited. */
  commentedPostIds: z
    .array(z.string().max(80))
    .default([])
    .transform((ids) => [...new Set(ids)].slice(-2000)),
  recentComments: z
    .array(recentCommentSchema)
    .default([])
    .transform((items) => items.slice(-20)),
  recentCommunities: z
    .array(recentCommunitySchema)
    .default([])
    .transform((items) => items.slice(-30)),
  recentSearches: z
    .array(recentSearchSchema)
    .default([])
    .transform((items) => items.slice(-20)),
  /** Rotates which recent communities are mixed into the browse feed. */
  feedCursor: z.number().int().nonnegative().default(0),
  notificationCursor: z
    .object({ boundary: z.string().nullable(), head: z.string().nullable(), offset: z.number().int().nonnegative() })
    .default({ boundary: null, head: null, offset: 0 }),
});

export type AccountState = z.infer<typeof stateSchema>;

export type Activity = z.infer<typeof activitySchema>;

export type PendingReply = z.infer<typeof replySchema>;

export type RecentComment = z.infer<typeof recentCommentSchema>;

export type ActionKind = "post" | "interaction";

export class AccountStore {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private failed = false;
  private constructor(
    private readonly dir: string,
    private readonly lock: FileHandle,
    private state: AccountState,
    private readonly clock: Clock,
  ) {}

  static async open(dir: string, accountId: string, options: { preserveState?: boolean; clock?: Clock } = {}): Promise<AccountStore> {
    const clock = options.clock ?? systemClock();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const lock = await acquireOwnerLock(dir);
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, identity: await processIdentity(process.pid) }));
      let state: AccountState;
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
        state = stateSchema.parse(raw);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AppError("invalid_account_state", { effect: "none", cause: error });
        state = stateSchema.parse({ version: 1, accountId, paused: null, actions: [], watched: {}, pendingVisits: [], lastBrowseAt: 0 });
      }
      if (state.accountId !== accountId) throw new AppError("account_state_mismatch", { effect: "none" });
      // Maintenance must refuse a changing/legacy state before open's first state.json write.
      // This comparison runs under the native exclusive owner lock, closing the preflight race.
      if (
        options.preserveState &&
        (raw === undefined || !isDeepStrictEqual(raw, parseAccountState(raw)) || state.actions.some((action) => action.status === "pending"))
      )
        throw new AppError("account_state_guard_failed", { effect: "none" });
      if (state.actions.some((action) => action.status === "pending")) {
        state.paused ??= "uncertain_delivery";
        for (const action of state.actions) if (action.status === "pending") action.status = "uncertain";
        for (const reply of state.replies) {
          const key = publicationHashKey(`post:${accountId}:${reply.postId}`, reply.commentId);
          if (reply.status === "pending" && state.actions.some((action) => action.key === key && action.status === "uncertain")) reply.status = "uncertain";
        }
        state.activities.push({ id: newId(), at: clock.now(), kind: "pause", outcome: "ok", errorCode: "uncertain_delivery" });
      }
      const store = new AccountStore(dir, lock, state, clock);
      await store.update(() => {});
      return store;
    } catch (error) {
      await removeMatchingLock(join(dir, "owner.lock"), lock);
      await lock.close();
      throw error;
    }
  }

  snapshot(): AccountState {
    return { ...structuredClone(this.state), ...(this.failed ? { paused: "state_write_failed" } : {}) };
  }

  update(change: (state: AccountState) => void): Promise<void> {
    if (this.closed) return Promise.reject(new AppError("account_store_closed", { effect: "none" }));
    const next = this.tail.then(async () => {
      if (this.failed) throw new AppError("account_state_write_failed", { effect: "unknown" });
      const state = this.snapshot();
      change(state);
      normalizeMutableState(state);
      try {
        await writeFileAtomic(join(this.dir, "state.json"), JSON.stringify(state));
        this.state = state;
      } catch (error) {
        this.failed = true;
        throw new AppError("account_state_write_failed", { effect: "unknown", cause: error });
      }
    });
    this.tail = next.catch(() => {});
    return next;
  }

  recordActivity(activity: Omit<Activity, "id" | "at">, now = this.clock.now()): Promise<void> {
    const entry = activitySchema.parse({ ...activity, id: newId(), at: now });
    return this.update((state) => {
      state.activities.push(entry);
    });
  }

  reserve(
    key: string,
    kind: ActionKind,
    limit: number,
    now: number,
    target = "",
    verification?: AccountState["actions"][number]["verification"],
  ): Promise<void> {
    return this.update((state) => {
      if (state.paused) throw new AppError("account_paused", { effect: "none" });
      if (state.actions.some((action) => action.key === key)) throw new AppError("duplicate_action", { effect: "none" });
      const unresolved = state.actions.filter((action) => action.status !== "sent");
      if (kind === "post" && unresolved.some((action) => action.kind === "post")) throw new AppError("new_post_quarantined", { effect: "none" });
      if (kind === "interaction" && unresolved.some((action) => action.kind === "interaction" && action.target === target))
        throw new AppError("target_quarantined", { effect: "none" });
      const day = dayKey(now, this.clock);
      if (state.actions.filter((action) => action.day === day && action.kind === kind).length >= limit) throw new AppError("daily_limit", { effect: "none" });
      state.actions = [
        ...state.actions.filter((action) => action.day !== day && action.status === "sent").slice(-2000),
        ...state.actions.filter((action) => action.day === day || action.status !== "sent"),
      ];
      state.actions.push({
        key,
        kind,
        day,
        at: now,
        status: "pending",
        target,
        ...(verification ? { verification: verificationSchema.parse(verification) } : {}),
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    await removeMatchingLock(join(this.dir, "owner.lock"), this.lock);
    await this.lock.close();
  }
}

/** Read-only validation for maintenance preflights before acquiring/writing account state. */
export function parseAccountState(value: unknown): AccountState {
  return normalizeMutableState(stateSchema.parse(value));
}

/** Uncertain attempts across all days; normal in-flight reservations are not delivery failures. */
export function quarantineSummary(state: AccountState) {
  const actions = state.actions.filter((action) => action.status === "uncertain");
  const prefix = `post:${state.accountId}:`;
  const posts = new Set(
    actions
      .filter((action) => action.kind === "interaction" && action.target.startsWith(prefix) && /^[A-Za-z0-9_-]{1,80}$/.test(action.target.slice(prefix.length)))
      .map((action) => action.target),
  );
  return { quarantinedPosts: posts.size, uncertainActions: actions.length, newPostQuarantined: actions.some((action) => action.kind === "post") };
}

/** A legacy global uncertainty pause can migrate only when every attempt has a known boundary. */
export function canIsolateUncertain(state: AccountState): boolean {
  const uncertain = state.actions.filter((action) => action.status === "uncertain");
  const prefix = `post:${state.accountId}:`;
  return (
    uncertain.length > 0 &&
    uncertain.every((action) =>
      action.kind === "post"
        ? action.target === `account:${state.accountId}`
        : action.target.startsWith(prefix) && /^[A-Za-z0-9_-]{1,80}$/.test(action.target.slice(prefix.length)),
    )
  );
}

/** The Asia/Shanghai calendar day of `now`, the day the daily limits count in. */
export function dayKey(now: number, clock: Clock = systemClock()): string {
  return dayOf(now, clock);
}

function publicationHashKey(channelId: string, commentId: string): string {
  return contentHash(JSON.stringify([channelId, commentId]));
}

function normalizeMutableState(state: AccountState): AccountState {
  state.actions = state.actions.map((action) => actionSchema.parse(action));
  state.seenFeedPostIds = [...new Set(state.seenFeedPostIds)].slice(-2000);
  state.activities = state.activities.slice(-300).map((activity) => activitySchema.parse(activity));
  state.replies = [
    ...state.replies.filter((reply) => reply.status === "replied" || reply.status === "skipped").slice(-2000),
    ...state.replies.filter((reply) => reply.status === "pending" || reply.status === "uncertain"),
  ].map((reply) => replySchema.parse(reply));
  return state;
}

async function processIdentity(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return;
  try {
    const [boot, stat] = await Promise.all([readFile("/proc/sys/kernel/random/boot_id", "utf8"), readFile(`/proc/${pid}/stat`, "utf8")]);
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(boot.trim()) && /^\d+$/.test(start)) return `${boot.trim()}:${start}`;
  } catch {
    // Legacy PID-only safety applies if Linux process identity cannot be read.
  }
}

async function removeMatchingLock(path: string, handle: FileHandle, expected?: BigIntStats): Promise<void> {
  const owned = expected ?? (await handle.stat({ bigint: true }));
  try {
    const current = await lstat(path, { bigint: true });
    if (
      current.isFile() &&
      current.dev === owned.dev &&
      current.ino === owned.ino &&
      current.size === owned.size &&
      current.mtimeNs === owned.mtimeNs &&
      current.ctimeNs === owned.ctimeNs
    )
      await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function acquireOwnerLock(dir: string): Promise<FileHandle> {
  const path = join(dir, "owner.lock");
  try {
    return await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // Reclaimers serialize through a separate exclusive file. A crashed recovery
  // fails closed; ordinary owners still acquire owner.lock exclusively.
  const recoveryPath = join(dir, "owner.recovery.lock");
  const recovery = await open(recoveryPath, "wx", 0o600);
  try {
    let previous: FileHandle;
    try {
      previous = await open(path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return await open(path, "wx", 0o600);
      throw error;
    }
    try {
      const before = await previous.stat({ bigint: true });
      const data: unknown = JSON.parse(await previous.readFile("utf8"));
      const owner = z
        .object({
          pid: z.number().int().positive().max(2147483647),
          identity: z
            .string()
            .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/)
            .optional(),
        })
        .parse(data);
      let dead = false;
      try {
        process.kill(owner.pid, 0);
        const identity = owner.identity && (await processIdentity(owner.pid));
        dead = !!identity && identity !== owner.identity;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") dead = true;
      }
      if (!dead) throw new AppError("account_store_owned", { effect: "none" });
      const after = await previous.stat({ bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
        throw new AppError("account_store_lock_changed", { effect: "none" });
      await removeMatchingLock(path, previous, before);
      return await open(path, "wx", 0o600);
    } finally {
      await previous.close();
    }
  } finally {
    await removeMatchingLock(recoveryPath, recovery);
    await recovery.close();
  }
}
