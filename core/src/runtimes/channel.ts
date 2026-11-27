import { join } from "node:path";

import {
  AgentBusyError,
  AgentRequestProjection,
  createAgent,
  createFileToolJournal,
  type Agent,
  type AgentEntry,
  type AgentHistoryMode,
  type AgentInternalEvent,
  type AgentTool,
  type AgentToolSet,
  type AgentTurnStream,
} from "@yesimbot/agent-runtime";
import { builtinToolCapability, channelStorageDirectory } from "@yesimbot/contracts";
import { isOwnerChat } from "@yesimbot/contracts/platforms";
import { AppError, newId, serialize, type Logger, systemClock, type Clock } from "@yesimbot/foundation";
import type { AssistantContent } from "ai";

import { isWebChatAccount, type ChatAccount } from "../accounts.js";
import { createContextWorkspaceTools, createFinishTool, createReadTool, type DeliveredNotice, type SendFailedNotice } from "../agents/tools.js";
import type { WillReservationOutcome, WillState } from "../agents/will.js";
import { type ChannelContext, deriveChannelKey } from "../channels/index.js";
import { createInternalHistoryProjectionPlugin } from "../conversations/internal-history.js";
import { createReplyJournalHistoryPlugin } from "../conversations/reply-journal.js";
import type { CoreEventBus } from "../events.js";
import type { MessageBatchInput } from "../message-batches/index.js";
import {
  CHANNEL_TYPE,
  createEvent,
  createMessage,
  isMessage,
  isMessageRecord,
  type ChannelType,
  type Event,
  type EventRecord,
  type Message,
  type MessageRecord,
} from "../messages/index.js";
import { runtimeToolBoundary } from "../tasks/tool-execution.js";
import { declareBuiltinTools } from "../tool-policy.js";
import { adminTurn } from "../tools/admins.js";
import { toolOutputBudget } from "../tools/output-budget.js";
import { AdmissionGate } from "./admission.js";
import { contextThresholds } from "./context-policy.js";
import { ContextWorkspace } from "./context-workspace.js";
import { RUNTIME_ERRORS } from "./errors.js";
import { conversationLogger } from "./log.js";
import { createLongTurnPlugin, type LongTurnPlugin } from "./long-turn.js";
import { MediaProjections } from "./media-projection.js";
import { createModelInputPlugin, findQuotedHistory, mergeAdjacentUserMessages } from "./model-input.js";
import { buildCoreSystemPrompt, buildPromptPreview, createPostHistoryPlugin, type PromptPreview } from "./prompt.js";
import { reviewBeforeRegion } from "./region-review.js";
import { ReplyDelivery } from "./reply-delivery.js";
import { TurnAnnouncer } from "./turn-announcer.js";
import { TurnLedger, type TurnDeliveryTracker } from "./turn-ledger.js";
import type { ChannelRuntimeOptions, PostOptions, RuntimeResult, TurnOutcome } from "./types.js";

export class ChannelRuntime {
  public readonly context: ChannelContext;
  public readonly selfId: string;

  private readonly agent: Agent;
  private readonly contextWorkspace: ContextWorkspace;
  private readonly longTurn: LongTurnPlugin;
  private readonly media: MediaProjections;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly admission: AdmissionGate;
  private readonly ledger: TurnLedger;
  private readonly announcer: TurnAnnouncer;
  private readonly queueKey = newId();
  private readonly streams = new Set<Promise<void>>();
  private stopped = false;
  private stopTask: Promise<void> | undefined;
  private readonly replies: ReplyDelivery;

  public constructor(
    private readonly events: CoreEventBus,
    private readonly options: ChannelRuntimeOptions,
  ) {
    this.context = options.channel.context;
    this.selfId = options.bot.selfId;
    this.media = new MediaProjections(
      options.imageProjection,
      options.videoProjection,
      options.channel.resources,
      (turnId) => !this.stopped && this.agent.getActiveTurnId() === turnId,
    );
    this.logger = conversationLogger("yesimbot.channel-runtime", deriveChannelKey(this.context));
    this.clock = options.clock ?? systemClock();
    this.announcer = new TurnAnnouncer(events, this.context, this.logger, (turnId) => this.ledger.isSuperseded(turnId));
    this.ledger = new TurnLedger({
      agent: () => this.agent,
      will: options.will,
      logger: this.logger,
      abortReply: (turnId) => this.replies.abortTurn(turnId),
      announceEnd: (turnId) => this.announcer.announce(turnId, false),
      channelOutputTools: options.channelOutputTools,
    });
    this.admission = new AdmissionGate({
      options,
      context: this.context,
      selfId: this.selfId,
      logger: this.logger,
      ledger: this.ledger,
      agent: () => this.agent,
      observe: (input) => this.agent.observe(input),
      state: () => this.state(),
      schedule: (task) => this.schedule(task),
      stopped: () => this.stopped,
      startAdmitted: (input, reservationId, batchInputs) => this.startAdmitted(input, reservationId, batchInputs),
    });
    this.replies = new ReplyDelivery({
      options,
      web: this.webOutput && isWebChatAccount(options.bot),
      clock: this.clock,
      logger: this.logger,
      stopped: () => this.stopped,
      turnAllowed: (turnId) =>
        !this.stopped &&
        !this.ledger.isSilent(turnId) &&
        !this.ledger.isSuperseded(turnId) &&
        this.agent.getActiveTurnId() === turnId &&
        (options.replyStillCurrent?.() ?? true),
      onDelivered: (notice) => this.announceDelivered(notice),
      onFailed: (notice) => this.announceSendFailed(notice),
    });
    const tools: AgentToolSet = [
      ...this.replies.tools,
      createReadTool(
        options.channel.resources,
        options.readImagePolicy,
        this.media.images,
        options.readVideoPolicy?.mode === "native" && this.media.videos
          ? {
              policy: {
                mode: "native",
                reserve: (turnId) => this.media.reserveVideoRead(turnId),
                release: (turnId) => this.media.releaseVideoRead(turnId),
              },
              projection: this.media.videos,
            }
          : undefined,
      ),
      createFinishTool({ innerThought: options.config.customInnerThought === true }),
    ];
    const channelKey = deriveChannelKey(this.context);
    this.longTurn = createLongTurnPlugin({
      trigger: contextThresholds(options.config.session.magicContext?.triggerTokens).trigger,
      delegation: options.tasks !== undefined,
    });
    const projection = new AgentRequestProjection();
    this.contextWorkspace = new ContextWorkspace(options.channel.conversation, projection, {
      config: options.config.session.magicContext,
      model: options.model,
      historianModel: options.historianModel ?? options.model,
      modelLimit: options.contextModelLimit,
      resolveModelLimit: options.resolveContextModelLimit,
      ...(options.historyProjection === "gemini-native" ? { mergeMessages: mergeAdjacentUserMessages } : {}),
      onDiagnostic: (metadata) => {
        const failed =
          metadata.event === "historian.failed" ||
          metadata.event === "historian.retry" ||
          metadata.event === "maintenance.failed" ||
          (metadata.event === "guard.estimate" && ["safety-deadline", "unresolved-unsafe", "mandatory-overflow"].includes(String(metadata.reason)));
        if (failed) this.logger.warn("runtime.context_budget", metadata);
        else this.logger.debug("runtime.context_budget", metadata);
      },
      onBackgroundSettled: () => this.scheduleArchiveCheck(),
      reviewBeforeRegion: (input) => this.reviewBeforeRegion(input),
    });
    tools.push(...createContextWorkspaceTools(this.contextWorkspace));
    this.agent = createAgent({
      id: channelKey,
      toolJournal: createFileToolJournal(join(options.channel.resources.path, "tool-journals", options.channel.conversation.currentSessionId())),
      model: options.model,
      maxRetries: options.config.modelRetries,
      requestProjection: projection,
      beforeModelRequest: async (context) => {
        const messages = await this.contextWorkspace.guard(context);
        if (context.historyMode !== "event") return messages;
        return {
          messages,
          activeTools: Object.keys(context.tools).filter((name) => !name.startsWith("ctx_")),
        };
      },
      maxOutputTokens: (model) => this.contextWorkspace.outputLimit(model),
      onModelUsage: ({ turnId, stepNumber, inputTokens }) => {
        this.longTurn.observe(turnId, inputTokens);
        this.contextWorkspace.observeUsage(turnId, stepNumber, inputTokens);
      },
      ...(this.webOutput
        ? {
            beforeToolPreamble: async ({ turnId, text, toolName }: { turnId: string; text: string; toolName: string }) => {
              // Sending is not an activity: the message itself appears.
              if (
                toolName === "send_message" ||
                this.stopped ||
                this.ledger.isSilent(turnId) ||
                this.announcer.isQuiet(turnId) ||
                this.ledger.isSuperseded(turnId) ||
                this.agent.getActiveTurnId() !== turnId ||
                !(options.replyStillCurrent?.() ?? true)
              )
                return;
              this.announcer.markWebActivity(turnId);
              this.announcer.announce(turnId, true, (text.trim() || `正在使用 ${toolName}…`).slice(0, 240));
            },
          }
        : {}),
      // Every platform delivers only through send_message; web chat also shows the pre-tool sentence as transient activity.
      requireTerminalTool: true,
      // A turn that runs out of steps says where it got to before it ends, instead of going silent.
      ...(options.config.maxSteps === undefined ? {} : { maxSteps: options.config.maxSteps }),
      stepLimitReportTools: ["send_message"],
      onStepLimit: ({ turnId, steps }) => this.logger.warn("runtime.step_limit", { turnId, steps }),
      ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
      storage: options.channel.conversation.storage,
      systemPrompt: () =>
        buildCoreSystemPrompt({
          channel: this.context,
          selfId: this.selfId,
          customInnerThought: options.config.customInnerThought,
          roleProfile: options.roleProfile,
        }),
      tools: declareBuiltinTools(tools, "core", this.context.platform),
      providerTools: Object.fromEntries(
        Object.entries(options.providerTools ?? {}).map(([name, tool]) => [
          name,
          {
            ...tool,
            capability: builtinToolCapability("provider", name) ?? (tool as unknown as AgentTool).capability,
          },
        ]),
      ),
      toolBoundary: runtimeToolBoundary(
        { platform: this.context.platform, kind: this.context.type === "direct" ? "direct" : "group" },
        "main",
        [],
        (messages) => adminTurn(this.context, options.config.admins, messages),
      ),
      plugins: [
        createReplyJournalHistoryPlugin(),
        this.ledger.supersessionPlugin(),
        this.replies.plugin(),
        {
          name: "core.context-workspace",
          enforce: "pre" as const,
          transformEntries: (entries: readonly AgentEntry[]) => {
            this.contextWorkspace.capture(entries);
          },
          onTurnFinish: (result: import("@yesimbot/agent-runtime").TurnResult) => {
            this.contextWorkspace.finish(result);
          },
        },
        createInternalHistoryProjectionPlugin(options.historyProjection ?? "default", projection),
        createModelInputPlugin(
          options.historyProjection ?? "default",
          true,
          options.directImageInput
            ? {
                resolveImage: (assetId, signal) => this.media.resolveInputImage(assetId, signal),
              }
            : undefined,
          (message, context) => findQuotedHistory(message, context, (match) => this.contextWorkspace.store.locate(match)),
        ),
        this.media.plugin(),
        this.ledger.silentTurnPlugin(),
        ...options.plugins,
        ...(options.tasks
          ? [
              options.tasks.plugin({
                scope: this.context,
                channel: channelStorageDirectory(this.context),
                session: `${options.channel.conversation.currentSessionId()}.jsonl`,
              }),
            ]
          : []),
        toolOutputBudget(join(options.channel.resources.path, "tool-outputs")),
        this.longTurn,
        createPostHistoryPlugin(options.roleProfile?.postHistoryInstructions),
      ],
    });
  }

  private get webOutput(): boolean {
    return isOwnerChat(this.context.platform, this.context.type);
  }

  /** The account this runtime speaks through; a different account means a new runtime. */
  public get account(): ChatAccount {
    return this.options.bot;
  }

  public async init(): Promise<void> {
    await this.agent.init();
    if (this.stopped) return;

    await this.admission.setup();
  }

  public handle(record: MessageRecord | EventRecord): Promise<RuntimeResult> {
    return this.schedule(async () => {
      this.assertOpen();
      const input = await this.commit(record);
      if (this.admission.batching && this.admission.enqueue(input)) {
        this.logger.debug("runtime.handle", {
          eventId: input.id,
          eventType: isMessage(input) ? "message" : "event",
          decision: "batched",
          result: "wait",
          activeTurnId: this.state().activeTurnId,
        });
        return { kind: "wait" as const, eventId: input.id };
      }
      if (this.options.will.decideBatch) {
        const batchDecision = await this.admission.decideBatch([input]);
        if (batchDecision.decision === "wait") this.agent.observe(input);
        const result =
          batchDecision.decision === "wait" ? { kind: "wait" as const, eventId: input.id } : await this.admission.startBatchDecision([input], batchDecision);
        this.logger.debug("runtime.handle", {
          eventId: input.id,
          eventType: isMessage(input) ? "message" : "event",
          decision: batchDecision.decision,
          result: result.kind,
          activeTurnId: this.state().activeTurnId,
        });
        return result;
      }
      const decision = await this.admission.decide(input);
      if (decision === "wait") this.agent.observe(input);
      const result = decision === "wait" ? { kind: "wait" as const, eventId: input.id } : await this.startAdmitted(input);
      this.logger.debug("runtime.handle", {
        eventId: input.id,
        eventType: isMessage(input) ? "message" : "event",
        decision,
        result: result.kind,
        activeTurnId: this.state().activeTurnId,
      });
      return result;
    });
  }

  /** Posts an event, or the account holder's private word, and starts a turn on it without asking Will. */
  public post(event: EventRecord | MessageRecord, options: PostOptions = {}): Promise<RuntimeResult> {
    const trigger = options.trigger ?? true;
    const ifBusy = options.ifBusy ?? "defer";
    return this.schedule(async () => {
      this.assertOpen();
      if (trigger && ifBusy === "reject" && this.agent.getActiveTurnId() !== null) throw new AgentBusyError();
      const input = await this.persist(event, trigger);
      await this.archiveIfOversize();
      const silent = options.delivery === "silent";
      const result = !trigger
        ? { kind: "wait" as const, eventId: input.id }
        : this.start(input, false, ifBusy, silent, undefined, options.historyMode, [], options.onTurnStart, false, options.quiet === true);
      this.logger.debug("runtime.post", {
        eventId: input.id,
        eventType: isMessageRecord(event) ? "whisper" : event.eventType,
        trigger,
        ifBusy,
        silent,
        quiet: options.quiet === true,
        result: result.kind,
      });
      return result;
    });
  }

  public wait(): Promise<void> {
    return this.agent.wait();
  }

  /** What this conversation's model receives, section by section, as frozen when its runtime started. */
  /** The user asked to stop: abort the running turn only. The runtime stays; the next message starts a new turn. */
  public async interruptActiveTurn(): Promise<boolean> {
    if (this.stopped || this.agent.getActiveTurnId() === null) return false;
    await this.agent.interrupt("user-stop");
    return true;
  }

  public async promptPreview(): Promise<PromptPreview> {
    const snapshot = await this.agent.promptSnapshot();
    const profile = this.options.roleProfile;
    return buildPromptPreview({
      ...snapshot,
      hasCard: Boolean(profile?.characterDefinition?.trim() || profile?.roleInstructions?.trim()),
      customInnerThought: this.options.config.customInnerThought === true,
      postHistoryInstructions: profile?.postHistoryInstructions,
    });
  }

  public stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.contextWorkspace.stop();
    this.logger.warn("runtime.stop_requested", {
      platform: this.context.platform,
      channelId: this.context.channelId,
      selfId: this.selfId,
      activeTurnId: this.agent.getActiveTurnId(),
      reason: "stop",
    });
    this.stopped = true;
    this.media.clearVideos();
    this.replies.invalidate();
    this.ledger.clearPending();
    this.stopTask = this.admission.stop().then(() =>
      this.schedule(async () => {
        await this.agent.interrupt("stop");
        await this.agent.stop();
        await this.replies.settle();
        await Promise.allSettled([...this.streams]);
      }),
    );
    return this.stopTask;
  }

  private async persist(record: MessageRecord | EventRecord, deferred = false): Promise<Message | Event> {
    const input = isMessageRecord(record) ? createMessage(record) : createEvent(record);
    await this.agent.append(input, { deferred });
    this.events.emit(isMessage(input) ? "yesimbot/message" : "yesimbot/event", input as never);
    return input;
  }

  private async commit(record: MessageRecord | EventRecord): Promise<Message | Event> {
    const input = await this.persist(record, true);
    await this.archiveIfOversize();
    return input;
  }

  private async startAdmitted(input: MessageBatchInput, reservationId?: string, batchInputs: readonly MessageBatchInput[] = []): Promise<RuntimeResult> {
    if (this.admission.batching || !isMessage(input)) {
      const result = this.start(input, true, this.context.type === "direct" ? "join" : "defer", false, reservationId, undefined, batchInputs);
      if (result.kind === "join" && reservationId) {
        await this.ledger.settleReservation(reservationId, { kind: "release", turnId: result.turnId, reason: "joined-active-turn" });
      }
      return result;
    }

    const coalesced = await this.ledger.joinPending(input, batchInputs, reservationId);
    if (coalesced) return coalesced;
    const activeTracker = this.ledger.activeTracker();
    // A visible post/whisper keeps its existing direct-chat join policy. It is not an ordinary
    // handle turn, so this admission must neither supersede it nor change its source policy.
    if (this.context.type === "direct" && activeTracker?.active && activeTracker.acceptsUserInput && !activeTracker.chatInputs) {
      const result = this.start(input, true, "join", false, reservationId, undefined, batchInputs);
      if (result.kind === "join" && reservationId) {
        await this.ledger.settleReservation(reservationId, { kind: "release", turnId: result.turnId, reason: "joined-active-turn" });
      }
      return result;
    }
    const joinedEvents = this.ledger.supersede();
    return this.start(input, true, "defer", false, reservationId, "conversation", [...joinedEvents, ...batchInputs], undefined, true);
  }

  private announceDelivered(notice: DeliveredNotice): void {
    if (notice.channelId !== this.context.channelId || !notice.messageId) return;
    this.ledger.recordDelivered(notice.turnId, notice.messageId);
    this.events.emit("yesimbot/delivered", {
      platform: this.context.platform,
      selfId: this.selfId,
      channel: { id: this.context.channelId, type: this.channelType() },
      messageId: notice.messageId,
      turnId: notice.turnId,
      text: notice.text,
    });
  }

  /** Surfaces send failures to operators; the model already received them as the tool result. */
  private announceSendFailed(notice: SendFailedNotice): void {
    this.events.emit(
      "yesimbot/event",
      createEvent({
        eventType: "delivery.failed",
        platform: this.context.platform,
        selfId: this.selfId,
        channel: { id: notice.channelId, type: this.channelType() },
        timestamp: this.clock.now(),
        text: "delivery failed",
        delivery: {
          turnId: notice.turnId,
          messageId: "",
          segmentIndex: notice.failedAt + 1,
          segmentTotal: notice.total,
          error: notice.error,
        },
      }),
    );
  }

  private channelType(): ChannelType {
    return this.context.type === "direct" ? CHANNEL_TYPE.direct : CHANNEL_TYPE.text;
  }

  private start(
    input: Message | Event,
    passive: boolean,
    ifBusy: "defer" | "join" | "reject",
    silent = false,
    reservationId?: string,
    historyMode?: AgentHistoryMode,
    batchInputs: readonly MessageBatchInput[] = [],
    onTurnStart?: PostOptions["onTurnStart"],
    ordinaryChat = false,
    quiet = false,
  ): RuntimeResult {
    const contextMessages = batchInputs.filter((candidate) => candidate !== input);
    const batchOptions = contextMessages.length ? { contextMessages } : {};
    const hasUserInput = isMessage(input) || contextMessages.some(isMessage);
    const turnHistoryMode = historyMode ?? (hasUserInput ? "conversation" : "event");
    const activeTurnId = this.agent.getActiveTurnId();
    const activeTracker = activeTurnId === null ? undefined : this.ledger.trackerOf(activeTurnId);
    // A background/event turn owns its history and delivery policy. Keep user input out of it,
    // including while its finish hooks are still running after the output consumer has closed.
    const canJoin = !this.ledger.isSuperseded(activeTurnId ?? "") && (!hasUserInput || (activeTracker?.active && activeTracker.acceptsUserInput));
    let stream: AgentTurnStream;
    try {
      if (ifBusy === "join" && activeTurnId !== null && canJoin) {
        this.agent.send(input, { ifBusy: "join", ...batchOptions });
        if (activeTracker?.chatInputs) activeTracker.chatInputs = [...new Set([...activeTracker.chatInputs, ...contextMessages, input])];
        return { kind: "join", eventId: input.id, turnId: activeTurnId };
      }
      stream = this.agent.run(input, {
        ifBusy: ifBusy === "join" ? "defer" : ifBusy,
        historyMode: turnHistoryMode,
        ...batchOptions,
      });
    } catch (cause) {
      for (const message of [input, ...contextMessages]) this.agent.observe(message);
      throw cause;
    }
    const tracker: TurnDeliveryTracker = {
      acceptsUserInput: hasUserInput && !silent && turnHistoryMode === "conversation",
      delivered: false,
      active: true,
      settled: false,
      ...(ordinaryChat ? { chatInputs: [...new Set([input, ...contextMessages])] } : {}),
      ...(reservationId ? { reservationId } : {}),
    };
    if (stream.turnId) {
      this.ledger.bind(tracker, stream.turnId);
      if (ordinaryChat && this.agent.getActiveTurnId() !== stream.turnId) this.ledger.setPending(stream.turnId, tracker);
    }
    const outcome = this.consume(stream, passive, silent, tracker, onTurnStart, quiet);
    const task = outcome.then(() => undefined);
    this.streams.add(task);
    void task.finally(() => this.streams.delete(task));
    return { kind: "run", eventId: input.id, done: task, outcome };
  }

  private async consume(
    stream: AsyncIterable<AgentInternalEvent>,
    passive: boolean,
    silent: boolean,
    tracker: TurnDeliveryTracker,
    onTurnStart?: PostOptions["onTurnStart"],
    quiet = false,
  ): Promise<TurnOutcome> {
    let consumeFailed = false;
    let terminal: "done" | "failed" | "aborted" | undefined;
    let turnId = "";
    // Activity is announced per started turn, independent of delivery-tracker binding, so every
    // announced start is cleared exactly once even when the tracker rejects a mismatched turn ID.
    const started = new Set<string>();
    try {
      for await (const event of stream) {
        if ("turnId" in event) {
          this.ledger.bind(tracker, event.turnId);
          turnId = tracker.turnId ?? turnId;
        }
        if (event.type === "turn.queued") continue;
        if (event.type === "turn.start") {
          if (onTurnStart && !started.has(event.turnId)) {
            // Observation must not hold up execution, and both sync and async failures are visible.
            try {
              void Promise.resolve(onTurnStart({ turnId: event.turnId, startedAt: new Date(this.clock.now()).toISOString() })).catch((cause) => {
                this.logger.warn("runtime.turn_start_observer_failed", { turnId: event.turnId, cause });
              });
            } catch (cause) {
              this.logger.warn("runtime.turn_start_observer_failed", { turnId: event.turnId, cause });
            }
          }
          started.add(event.turnId);
          if (quiet) this.announcer.markQuiet(event.turnId);
          this.announcer.announce(event.turnId, true);
          if (silent) this.ledger.markSilent(event.turnId);
          this.logger.debug("runtime.turn.start", { turnId: event.turnId, silent });
          continue;
        }
        if (event.type === "turn.step") {
          if (this.announcer.takeWebActivity(event.turnId)) this.announcer.announce(event.turnId, true);
          this.logger.debug("runtime.turn.step", {
            turnId: event.turnId,
            stepNumber: event.step,
            finishReason: event.finishReason,
            usage: event.usage,
            reasoningText: event.reasoningText === undefined ? undefined : event.reasoningText.slice(0, 1000),
          });
          continue;
        }
        if (event.type === "turn.done") {
          terminal = "done";
          tracker.active = false;
          this.logger.debug("runtime.turn.done", { turnId: event.turnId });
          continue;
        }
        if (event.type === "tool.start") {
          this.logger.debug("runtime.tool.start", { turnId: event.turnId, toolName: event.toolName, toolCallId: event.toolCallId });
          continue;
        }
        if (event.type === "tool.done") {
          this.logger.debug("runtime.tool.done", { turnId: event.turnId, toolName: event.toolName, toolCallId: event.toolCallId });
          continue;
        }
        if (event.type === "tool.failed") {
          this.logger.warn("runtime.tool.failed", { turnId: event.turnId, toolName: event.toolName, toolCallId: event.toolCallId, error: event.error.message });
          continue;
        }
        if (event.type === "message.appended" && "turnId" in event && event.message.role === "assistant") {
          const content = renderAssistantText(event.message.content);
          if (content !== undefined) {
            this.logger.debug("runtime.output.text", { turnId, messageId: event.message.id, text: content.slice(0, 2000) });
          }
          continue;
        }
        if (event.type === "turn.failed") {
          terminal = "failed";
          tracker.active = false;
          this.logger.warn("runtime.turn.failed", { turnId: event.turnId, error: event.error.message });
          break;
        }
        if (event.type === "turn.aborted") {
          terminal = "aborted";
          tracker.active = false;
          this.logger.warn("runtime.turn.aborted", { turnId: event.turnId, reason: event.reason });
          break;
        }
      }
      if (terminal !== "failed" && terminal !== "aborted") {
        terminal = "done";
        if (passive) await this.options.will.observe?.({ turnId, status: "done", messages: [] });
      }
    } catch (cause) {
      consumeFailed = true;
      this.logger.warn("runtime.turn.consume_failed", { turnId, cause });
    } finally {
      for (const id of started) {
        this.announcer.announce(id, false);
        this.announcer.clearQuiet(id);
      }
      tracker.active = false;
      if (tracker.reservationId) {
        const outcome: WillReservationOutcome =
          tracker.delivered && tracker.turnId && tracker.deliveredMessageId
            ? { kind: "commit", turnId: tracker.turnId, messageId: tracker.deliveredMessageId }
            : {
                kind: "release",
                ...(tracker.turnId ? { turnId: tracker.turnId } : {}),
                reason: consumeFailed ? "consume-failed" : terminal === "failed" ? "failed" : terminal === "aborted" ? "aborted" : "done-without-delivery",
              };
        await this.ledger.settleAtTerminal(tracker, outcome).catch((cause) => {
          this.logger.warn("runtime.will_reservation_settlement_failed", { reservationId: tracker.reservationId, outcome, cause });
        });
      }
      this.ledger.release(tracker);
      this.scheduleArchiveCheck();
    }
    return { status: consumeFailed ? "failed" : (terminal ?? "done"), delivered: tracker.delivered };
  }

  private reviewBeforeRegion(input: Pick<Parameters<typeof reviewBeforeRegion>[0], "request" | "sourceEntryIds" | "signal">): Promise<void> {
    return reviewBeforeRegion({
      ...input,
      plugins: this.options.plugins,
      conversation: this.options.channel.conversation,
      logger: this.logger,
      stopped: () => this.stopped,
    });
  }

  private state(): WillState {
    return { activeTurnId: this.agent.getActiveTurnId() };
  }

  private schedule<T>(task: () => Promise<T>): Promise<T> {
    return serialize(this.queueKey, task);
  }

  private assertOpen(): void {
    if (this.stopped) throw new AppError(RUNTIME_ERRORS.runtime_stopped, { effect: "none" });
  }

  private scheduleArchiveCheck(): void {
    if (this.webOutput || this.stopped || (this.options.archiveMaxBytes ?? 0) <= 0) return;
    void this.schedule(async () => {
      if (this.stopped || this.agent.getActiveTurnId() !== null) return;
      await this.archiveIfOversize();
    }).catch(() => this.logger.warn("runtime.archive_check_failed", { reason: "archive_failed" }));
  }

  private async archiveIfOversize(): Promise<void> {
    const maxBytes = this.options.archiveMaxBytes ?? 0;
    // Web chat keeps its session until the user explicitly starts a new conversation.
    if (this.webOutput || this.stopped || maxBytes <= 0 || this.contextWorkspace.status().backgroundActive) return;
    await this.options.channel.conversation.archiveIfOversize(maxBytes);
  }
}

function renderAssistantText(content: AssistantContent): string | undefined {
  if (typeof content === "string") return content.trim() ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content.map((part) => (typeof part === "string" ? part : part.type === "text" ? part.text : "")).join("");
  return text.trim() ? text : undefined;
}
