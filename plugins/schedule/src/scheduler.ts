import { isOwnerChat } from "@yesimbot/contracts/platforms";
import { errorFields, logger, type Clock, type Logger } from "@yesimbot/foundation";
import { CHANNEL_TYPE, type EventRecord } from "koishi-plugin-yesimbot/kernel";

import { scheduleHostState } from "./host-state.js";
import type { ScheduleRunReason } from "./run-history.js";
import { directUserId, ScheduleStore } from "./store.js";
import type { Schedule, ScheduleLastResult } from "./types.js";

/** Upper bound on concurrent Core trigger calls the scheduler admits. */
export const MAX_CONCURRENT_TRIGGERS = 5;

/** Node's largest reliable timeout delay; longer waits are re-evaluated in chunks. */
const MAX_TIMER_DELAY = 0x7fffffff;

const HEARTBEAT_PROMPT = `这是一次定时心跳检查，不是用户刚发来的消息，也不要求一定回复。
对话历史里标着“之前的一次心跳检查”的，是以前心跳的检查过程和结论：先看上次查到哪一步、哪些已经告诉对方、哪些还在等结果，接着往下查，不从头重复同样的检查。
这次可以查两类事：
1. 跟进：本会话聊过但还在等结果、结论或解决办法的事情。例如旧话题今天有了明确结论，或原先的问题找到实际可用的解决办法，就在核实后接回那段对话，自然告诉对方新发现。
2. 新动态：从当前会话有权读取的记忆和近期聊天里，找出对方关心的人和事、兴趣和在等的消息，挑一两件最可能有新进展的，去搜索或查看相关连接，看有没有真正新的、对方会想知道的消息。每次只挑少数几件，和上次查过的错开，不要漫无目的地广泛搜索。按具体事项定向、限量检索记忆，不要无条件读取整个记忆库。
每次检查都以当前实际提供的工具和连接为准，不沿用上次“没有连接”的结论。需要检查相关服务时直接调用对应工具，由工具结果判断有没有可用连接。
只有发现与对方相关、尚未告知、有依据且值得此时打断的新进展，或推进原事项确实需要用户补充信息时，才以当前角色简短自然地发起对话，说明它和对方关心的事有什么联系；不要写成例行检查报告。区分已核实事实和不确定信息；不得为了对话而对话，不重复旧提醒，不因无人回应继续催促。遵守上下文中的免打扰和通知偏好。
主动跟进先说核实后的新结论，再给当前最直接的一种办法。通常用一条短消息说完，总体以约100个汉字为宜；确有必要才补第二条，关键条件需要时可略长，不机械截断。首次消息不要塞入多种方案、版本沿革、核实经过或风险清单，只保留影响结论和采用办法的关键条件，必要时可附一条主要来源。用自然聊天口吻，不写固定开场、分节或套路总结，更多细节等对方追问。若当前会话明确要求完整结果、步骤或代码，按要求给足；不要补充未经核实的结论。
检查当前会话实际发出的消息和已有任务 notes，避免再次通知同一事件；发送失败不得视为已通知。实际发送记录就是本轮通知的依据，无需为维护检查记录另建后台任务，也不发送“已完成检查”“已更新记录”等过程汇报。
群聊只使用本群可见的信息，不检查或公开私人邮箱、其他会话或个人私密记忆。心跳只做检查和通知，不代表获准替用户发送邮件或执行其他外部修改。
没有值得告知的新进展，也没有推进原事项必需的新问题，就调用 finish 静默结束。无法核实的进展或已经告知的内容也保持沉默，不发送“暂无更新”、问候或检查报告。`;

/** Outside the owner's web conversation a heartbeat stays inside its own conversation. */
const LOCAL_HEARTBEAT =
  "本计划只属于当前会话：不得列出、读取其他会话的聊天记录，也不把其他会话的待办搬到这里。新会话必须由用户单独开启心跳；新增连接或会话不代表允许代它创建计划或主动联系。";

/** The owner's web conversation may look across the whole instance (user, 2026-11-18: 「网页主对话看全实例」). */
const INSTANCE_HEARTBEAT =
  "这是主人的网页主对话，心跳可以巡查整个实例：用 instance_tasks、instance_schedules 看各会话的后台任务和定时任务有没有失败、卡住或在等主人处理；用 list_conversations、read_conversation 看各群聊和私聊的近况，有没有需要主人知道或处理的事（有人找主人、请求一直没人回应、出了问题）；查看已连接的邮箱和日历里需要主人处理的新事项。只把需要主人知道或处理的事告诉主人，转述只带必要信息；不在别的会话里代主人发言，也不替别的会话创建计划或主动联系。";

/** Silent: the investigation is not shown, but a conclusion worth telling is still sent. */
const SILENT_HEARTBEAT = "这是一次静默心跳：检查过程不会显示给对方，不要发“我去查一下”之类的过程消息；查到值得告诉对方的结论，照常发消息。";

/** Explicit: the heartbeat wakes the conversation's bot, which acts in the conversation as usual. */
const EXPLICIT_HEARTBEAT = "这是一次显式心跳：相当于在对话里把你叫醒，像平时一样在对话里活动。";

/** Starts a one-shot timer and returns its cancel; the host's timers go away with the plugin. */
export type ScheduleTimer = (callback: () => void, milliseconds: number) => () => void;

type Outcome = Exclude<ScheduleLastResult["status"], "submitting">;

/** What Core's `Messenger.postAndReport` resolves with; older cores only offer `post`. */
type PostReport = { kind: string; outcome?: { status: "done" | "failed" | "aborted"; delivered: boolean } } | undefined;

type DueOptions = {
  trigger: true;
  ifBusy: "defer" | "reject";
  delivery: Schedule["delivery"];
  /** The process stays out of sight while what the turn sends is still delivered (a silent heartbeat). */
  quiet?: true;
  historyMode?: "conversation";
  onTurnStart?: (turn: { turnId: string; startedAt: string }) => Promise<void>;
};

/** What the scheduler needs from its host besides the Store. */
export interface ScheduleSchedulerDeps {
  readonly messenger: DuePoster;
  readonly timer: ScheduleTimer;
  readonly clock: Clock;
  /** Outlives plugin reloads (the Core messenger): turns it admitted stay owned across a schedule-only reload. */
  readonly triggerHost?: object;
  readonly logger?: Logger;
}

export interface DuePoster {
  post(event: EventRecord, options: DueOptions): Promise<unknown>;
  postAndReport?(event: EventRecord, options: DueOptions): Promise<PostReport>;
}

interface LiveTrigger {
  admitted: boolean;
}

/**
 * Earliest-due timer scheduler over the durable ScheduleStore. It arms one
 * timer for the earliest enabled `nextRunAt`, and on wake claims every
 * currently due occurrence through the Store before submitting a complete
 * `schedule.due` EventRecord to Core. Post calls are bounded
 * to `MAX_CONCURRENT_TRIGGERS`; a due occurrence without a free slot is
 * recorded as missed instead of entering a backlog. Each occurrence's result
 * is how its turn ended. Time comes from the Clock and the
 * timer from the host.
 */
export class ScheduleScheduler {
  private readonly live: Map<string, LiveTrigger>;
  private readonly logger: Logger;
  private cancelTimer: (() => void) | null = null;
  private running = false;

  public constructor(
    private readonly store: ScheduleStore,
    private readonly deps: ScheduleSchedulerDeps,
  ) {
    this.logger = deps.logger ?? logger("yesimbot.schedule");
    this.live = scheduleHostState(deps.triggerHost ?? deps.messenger, "triggers", () => new Map<string, LiveTrigger>());
  }

  /** Recovers persisted schedules, then arms the earliest due timer. */
  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const repairs = await this.store.recover(new Date(this.deps.clock.now()), (id, occurrenceAt) => this.live.has(triggerKey(id, occurrenceAt)));
    for (const repair of repairs ?? []) {
      const detail = { id: repair.id, title: repair.title, occurrenceAt: repair.occurrenceAt };
      if (repair.status === "replay") this.logger.info("schedule.replay_late", detail);
      else this.logger.warn(`schedule.${repair.status}`, detail);
    }
    await this.arm();
  }

  /**
   * Prevents new due submissions and clears the pending timer. Persisted rows
   * stay intact, and already admitted trigger calls remain owned by the
   * existing Core trigger drain and runtime stop behavior.
   */
  public stop(): void {
    this.running = false;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  /** Re-evaluates persisted earliest work after a successful management mutation. */
  public async rearm(): Promise<void> {
    await this.arm();
  }

  private async arm(): Promise<void> {
    if (!this.running) return;
    const rows = await this.store.listEnabled();
    if (!this.running) return;
    const earliest = rows[0];
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (!earliest?.nextRunAt) return;
    const delay = Math.max(0, Date.parse(earliest.nextRunAt) - this.deps.clock.now());
    this.cancelTimer = this.deps.timer(
      () => {
        this.cancelTimer = null;
        void this.wake();
      },
      Math.min(delay, MAX_TIMER_DELAY),
    );
  }

  private async wake(): Promise<void> {
    if (!this.running) return;
    const now = this.deps.clock.now();
    const rows = await this.store.listEnabled();
    for (const row of rows) {
      if (!this.running) break;
      const occurrenceAt = row.nextRunAt;
      if (occurrenceAt === null || Date.parse(occurrenceAt) > now) break;
      const key = triggerKey(row.id, occurrenceAt);
      if (this.live.has(key)) continue;
      const owner: LiveTrigger = { admitted: false };
      // Register before claim: recovery must also recognize a claim whose write is still in flight.
      this.live.set(key, owner);
      const release = () => {
        if (this.live.get(key) === owner) this.live.delete(key);
      };
      let submitted = false;
      try {
        const claimed = await this.store.claim(row.id, occurrenceAt);
        if (!claimed) continue;
        if (!this.running) {
          await this.store.finish(claimed.id, occurrenceAt, "interrupted", undefined, undefined, "runtime_closed");
          continue;
        }
        if ([...this.live.values()].filter((trigger) => trigger.admitted).length >= MAX_CONCURRENT_TRIGGERS) {
          await this.store.finish(claimed.id, occurrenceAt, "missed", undefined, undefined, "concurrency_limit");
          this.logger.warn("schedule.missed", { id: claimed.id, title: claimed.title, occurrenceAt, reason: "too_many_running" });
          continue;
        }
        owner.admitted = true;
        submitted = true;
        void this.runTrigger(claimed, occurrenceAt)
          .catch((cause) => this.logger.warn("schedule.history_finish_failed", { id: claimed.id, occurrenceAt, ...errorFields(cause) }))
          .finally(release);
      } finally {
        if (!submitted) release();
      }
    }
    await this.arm();
  }

  private async runTrigger(row: Schedule, occurrenceAt: string): Promise<void> {
    const event = buildDueEvent(row, occurrenceAt, this.deps.clock.now());
    const detail = { id: row.id, title: row.title, occurrenceAt };
    this.logger.info("schedule.fired", detail);
    const heartbeat = row.purpose === "heartbeat";
    const options: DueOptions = {
      trigger: true,
      ifBusy: heartbeat ? "reject" : "defer",
      // A heartbeat may always speak (user, 2026-11-16: "静默心跳是调查过程静默，你不能阻止bot给我发送消息"):
      // silent only hides its investigation; explicit wakes the conversation's bot as usual.
      delivery: heartbeat ? "channel" : row.delivery,
      ...(heartbeat && row.delivery === "silent" ? { quiet: true as const } : {}),
      // Heartbeats need their own conversation to find follow-ups. Ordinary scheduled tasks keep
      // event-only history; Core still separates user messages from either background turn.
      ...(row.purpose === "heartbeat" ? { historyMode: "conversation" as const } : {}),
    };
    let status: Outcome;
    let notified: boolean | undefined;
    let error: { name: string; message: string } | undefined;
    let reason: ScheduleRunReason | undefined;
    try {
      const messenger = this.deps.messenger;
      const report = messenger.postAndReport
        ? await messenger.postAndReport(event, {
            ...options,
            onTurnStart: (turn) => this.store.started(row.id, occurrenceAt, turn),
          })
        : void (await messenger.post(event, options));
      status = outcomeOf(report, row.delivery, row.purpose === "heartbeat");
      if (row.purpose === "heartbeat" && report?.outcome) notified = report.outcome.delivered;
      if (status === "failed") {
        error = { name: "TurnFailed", message: "turn_failed" };
        reason = "turn_failed";
      } else if (status === "interrupted") reason = report?.kind === "closed" ? "runtime_closed" : "turn_aborted";
    } catch (cause) {
      status = row.purpose === "heartbeat" && cause instanceof Error && cause.name === "AgentBusyError" ? "missed" : "failed";
      reason = status === "missed" ? "conversation_busy" : "submission_failed";
      error = cause instanceof Error ? { name: cause.name, message: cause.message } : { name: "Error", message: String(cause) };
    }
    await this.store.finish(row.id, occurrenceAt, status, error, notified, reason);
    if (status === "completed" || status === "accepted") this.logger.info("schedule.finished", { ...detail, result: status });
    else this.logger.warn("schedule.finished", { ...detail, result: status, ...(error ? { error: error.message } : {}) });
  }
}

function triggerKey(id: string, occurrenceAt: string): string {
  return JSON.stringify([id, occurrenceAt]);
}

/**
 * The durable result of one submitted occurrence. A turn that ended without sending anything to a
 * channel schedule is not a success: the owner saw nothing. Unknown outcomes stay `accepted`.
 */
function outcomeOf(report: PostReport, delivery: Schedule["delivery"], heartbeat = false): Outcome {
  if (report?.kind === "closed") return "interrupted";
  if (report?.kind !== "run" || !report.outcome) return "accepted";
  if (report.outcome.status === "failed") return "failed";
  if (report.outcome.status === "aborted") return "interrupted";
  return report.outcome.delivered || delivery === "silent" || heartbeat ? "completed" : "undelivered";
}

function channelTypeOf(type: string) {
  return type === "direct" ? CHANNEL_TYPE.direct : CHANNEL_TYPE.text;
}

function buildDueEvent(row: Schedule, occurrenceAt: string, now: number): EventRecord<"schedule.due"> {
  // A direct schedule names its private chat's user, so the run lands in that same conversation.
  const userId = row.type === "direct" ? directUserId(row.platform, row.channelId, row.userId) : undefined;
  const notes = row.notes
    ? `\n\n${row.purpose === "heartbeat" ? "上次检查记录与已通知事项（用于去重）" : "你之前执行这个任务时记下的做法（先照着试）"}：\n${row.notes}`
    : "";
  return {
    eventType: "schedule.due",
    platform: row.platform,
    selfId: row.selfId,
    timestamp: now,
    channel: { id: row.channelId, type: channelTypeOf(row.type) },
    ...(userId ? { user: { id: userId } } : {}),
    text:
      `${row.purpose === "heartbeat" ? HEARTBEAT_PROMPT + "\n" + (isOwnerChat(row.platform, row.type) ? INSTANCE_HEARTBEAT : LOCAL_HEARTBEAT) + "\n" + (row.delivery === "silent" ? SILENT_HEARTBEAT : EXPLICIT_HEARTBEAT) + "\n" : ""}Schedule "${row.title}" is due.\n${row.prompt}${notes}\n\n` +
      (row.purpose === "heartbeat"
        ? `本任务 ID：${row.id}。本计划的任务内容和已有 notes 是这次检查的关注重点，不在上述范围之外扩大检查或通知。`
        : `${row.delivery === "silent" ? "本次为静默执行：你写的文字不会发送给任何人，不要为用户撰写回复；任务完成后直接调用 finish 结束。" : ""}做完后，如果这次摸清了有效做法或要避开的坑，用 schedule_update（id: ${row.id}）的 notes 换成简短步骤：用哪个工具、点哪里、避开什么。不要记录密码、cookie、token 或验证码。`),
    schedule: { id: row.id, title: row.title, kind: row.kind, scheduledFor: occurrenceAt },
    // Later heartbeats see this run's process and conclusions under this label, not the one-time prompt.
    ...(row.purpose === "heartbeat" ? { historyNote: `之前的一次心跳检查（计划「${row.title}」）` } : {}),
  };
}
