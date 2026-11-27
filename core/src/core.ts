import { resolve } from "node:path";

import { createEntry, EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import { channelStorageDirectory } from "@yesimbot/contracts";
import { isRetiredPlatform } from "@yesimbot/contracts/platforms";
import { closeStateDb, configureStorage, errorFields, logger, parseConfig, systemClock } from "@yesimbot/foundation";

import type { ChatAccount, SameAccount } from "./accounts.js";
import { Agents } from "./agents/index.js";
import { createReadTool } from "./agents/tools.js";
import { Channels, type ChannelContext } from "./channels/index.js";
import { moduleConfig, type Config } from "./config.js";
import { CONVERSATION_ERRORS, conversationError } from "./conversations/errors.js";
import type { ConversationReadOptions } from "./conversations/index.js";
import { Devices, RuntimeIdentity } from "./devices.js";
import type { CoreEventBus } from "./events.js";
import { MessageBatchRegistry } from "./message-batches/index.js";
import { CHANNEL_TYPE, type MessageRecord } from "./messages/index.js";
import { Messenger } from "./messengers/index.js";
import { ModelService, type ModelServiceHost } from "./models/index.js";
import { defaultNetworkPolicyFile, startNetworkPolicy } from "./network.js";
import { ChannelOverrides } from "./overrides.js";
import type { Resources } from "./resources/index.js";
import { resolveReadImagePolicy, Runtimes } from "./runtimes/index.js";
import { createModelInputPlugin } from "./runtimes/model-input.js";
import type { PromptPreview } from "./runtimes/prompt.js";
import { TASK_ERRORS, taskError } from "./tasks/errors.js";
import { rejectedTaskReportDraft } from "./tasks/failure.js";
import { Tasks } from "./tasks/manager.js";
import { selectTaskModel, taskModelChoices } from "./tasks/models.js";
import { taskSourceMatchesScope } from "./tasks/source.js";
import type { TaskRecord } from "./tasks/store.js";
import { runtimeToolBoundary } from "./tasks/tool-execution.js";
import { declareBuiltinTools } from "./tool-policy.js";
import { adminSource } from "./tools/admins.js";

const SYSTEM_CLOCK = systemClock();

const log = logger("yesimbot.core");

export interface ConversationArchiveRequest {
  readonly channel: string;
  readonly session: string;
}

/**
 * What a host gives Core (leave-koishi 6.1): Koishi's service adapts its Context to it today, `apps/server` after Koishi.
 * Everything platform- or host-specific (Sessions, chat commands, log sinks, form pickers) stays with the host.
 */
export interface CoreHost {
  /** The instance directory that relative paths resolve against. */
  readonly baseDir: string;
  /** The `yesimbot` module's config as stored; Core parses it. */
  readonly config: unknown;
  /** What runtimes and the model registry announce, and the registry revision they follow. */
  readonly events: CoreEventBus & Pick<ModelServiceHost, "emit">;
  /** The live account for a platform and account ID, from the host's adapters or connectors. */
  account(platform: string, selfId: string): ChatAccount | undefined;
  /** Whether two handles are one account; identity when absent. */
  readonly sameAccount?: SameAccount;
  /** The account a shared conversation is assigned to; none when absent. */
  assignee?(context: ChannelContext): Promise<string | undefined>;
  /** The member runtime this instance serves (`YESIMBOT_TENANT_ID`), if any. */
  readonly tenantId?: string;
}

export interface ConversationAccess {
  read(context: ChannelContext, options: ConversationReadOptions): Promise<MessageRecord[]>;
  locate(context: ChannelContext): Promise<{ channel: string; session: string }>;
  /** Trusted transports only. Records actual output without adding a second model message. */
  recordSent(context: ChannelContext, message: Pick<MessageRecord, "messageId" | "timestamp" | "parts">): Promise<void>;
  /** Trusted instance administration only; callers must authenticate before invoking. */
  archive(request: ConversationArchiveRequest): Promise<void>;
  /** Read-only: the prompt this conversation's model receives, section by section. Starts its runtime if needed. */
  prompt(context: ChannelContext): Promise<PromptPreview>;
  /** Trusted transports only: stop the conversation's running turn. False when nothing was running. */
  interrupt(context: ChannelContext): Promise<boolean>;
}

/**
 * What modules use of Core, under any host: `ctx.yesimbot` under Koishi, `ctx.core` of an extension. Trusted members are
 * marked on {@link ConversationAccess}.
 */
export interface CoreService {
  readonly config: Config;
  readonly model: ModelService;
  /** `accept` takes a connector's input (convention 09): the record is made only once its conversation is admitted. */
  readonly messenger: Pick<Messenger, "accept" | "post" | "postAndReport" | "whisper">;
  readonly message: Pick<MessageBatchRegistry, "use">;
  readonly agent: Pick<Agents, "use" | "will">;
  readonly resource: Resources;
  readonly identity: RuntimeIdentity;
  readonly devices: Devices;
  readonly tasks: Tasks;
  /** One conversation's own role card and reply model (the web chat's choices). */
  readonly overrides: Pick<ChannelOverrides, "get" | "set">;
  readonly conversation: ConversationAccess;
}

/**
 * Core, composed from host-neutral parts: the model registry, channels, runtimes, background tasks and the kernel
 * messenger. Construct it once per instance, call `start()`, then `ready()` once every module has registered (model
 * providers among them), and `stop()` on shutdown.
 */
export class YesImBotCore implements CoreService {
  public readonly config: Config;
  public readonly model: ModelService;
  public readonly messenger: Messenger;
  public readonly message: MessageBatchRegistry;
  public readonly agent: Agents;
  public readonly channels: Channels;
  /** The channels as modules read them: resources by conversation. */
  public readonly resource: Resources;
  public readonly runtimes: Runtimes;
  public readonly identity: RuntimeIdentity;
  public readonly devices: Devices;
  public readonly tasks: Tasks;
  /** One conversation's own role card and reply model (the web chat's choices). */
  public readonly overrides: ChannelOverrides;
  public readonly conversation: ConversationAccess;

  private readonly network: Promise<() => void>;
  private stopped = false;

  public constructor(private readonly host: CoreHost) {
    const config = parseConfig(moduleConfig, host.config ?? {});
    this.config = config;
    const dataRoot = resolve(host.baseDir, config.basePath || "data/yesimbot");
    // Shared module data (`.trellis/spec/conventions/08-storage.md`): `<data root>/state.sqlite` and `<data root>/<module>/`.
    configureStorage({ dataRoot });
    // The egress policy of every outbound request (`.trellis/spec/conventions/05-network.md`).
    this.network = startNetworkPolicy({ file: resolve(host.baseDir, defaultNetworkPolicyFile()) });
    this.identity = new RuntimeIdentity(dataRoot, host.tenantId);
    this.devices = new Devices(this.identity);
    this.model = new ModelService(
      { baseDir: host.baseDir, emit: host.events.emit.bind(host.events) },
      {
        basePath: config.basePath,
        auxiliaryModel: config.auxiliaryModel,
        visionModel: config.visionModel,
        chatModel: config.chatModel,
        imageModel: config.imageModel,
        imageEditModel: config.imageEditModel,
        videoInput: config.videoInput,
        logLevel: config.logLevel,
      },
    );
    this.channels = new Channels({
      // Against the instance directory, not the working directory: only Koishi always started inside the former.
      basePath: config.basePath ? resolve(host.baseDir, config.basePath) : host.baseDir,
      imageInput: config.imageInput,
      videoInput: config.videoInput,
      readTimeoutMs: config.resourceReadTimeout * 1000,
    });
    this.resource = this.channels;
    this.agent = new Agents(config);
    this.message = new MessageBatchRegistry();
    this.overrides = new ChannelOverrides((context) => this.runtimes.release(context));
    this.tasks = new Tasks(resolve(dataRoot, "tasks"), this.taskHost());
    this.runtimes = new Runtimes(host.events, this.channels, this.model, config, this.agent, this.message, this.overrides, this.tasks, host.sameAccount);
    this.messenger = new Messenger({
      allowedChannels: () => config.allowedChannels,
      channels: this.channels,
      runtimes: this.runtimes,
      account: (platform, selfId) => host.account(platform, selfId),
      assignee: async (context) => (await host.assignee?.(context)) || undefined,
    });
    this.conversation = this.conversationAccess();
  }

  public async start(): Promise<void> {
    await this.identity.tenantId();
    await this.channels.start();
    await this.tasks.start();
  }

  /** Every module has registered: the model registry loads its providers. */
  public ready(): void {
    this.model.start();
  }

  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.tasks.stop();
    await this.messenger.stop();
    this.model.stop();
    (await this.network)();
    closeStateDb();
  }

  private modelChoices(scope?: ChannelContext) {
    const config = this.config;
    if (config.taskModels?.length) return taskModelChoices(config.taskModels, undefined);
    try {
      const current = this.model.resolveChatModel(scope ? this.runtimes.chatModelFor(scope) : (config.chatModel ?? ""), scope).fullId;
      return taskModelChoices(undefined, current);
    } catch {
      return [];
    }
  }

  private workerModel(record: { modelRef?: string }, scope: ChannelContext) {
    const ref = selectTaskModel(
      this.modelChoices(scope),
      record.modelRef,
      this.model.listChatModels().map((model) => model.fullId),
    );
    try {
      return this.model.resolveChatModel(ref, scope);
    } catch {
      throw taskError(TASK_ERRORS.task_model_unavailable);
    }
  }

  private taskHost(): ConstructorParameters<typeof Tasks>[1] {
    const config = this.config;
    return {
      changed: () => {},
      modelChoices: (origin) => this.modelChoices(origin.scope),
      validateModel: async (record, origin) => {
        const scope = origin?.scope ?? (await this.channels.storedContext(record.channel));
        if (!scope) throw taskError(TASK_ERRORS.task_conversation_missing);
        this.workerModel(record, scope);
      },
      canResumeHandoff: async (record) => {
        const scope = await this.channels.storedContext(record.channel);
        if (!scope) return false;
        const channel = await this.channels.resolve(scope);
        if (`${channel.conversation.currentSessionId()}.jsonl` !== record.session) return false;
        this.workerModel(record, scope);
        const deviceId = record.handoff?.deviceId;
        if (!deviceId) return true;
        const device = (await this.devices.list()).find((item) => item.deviceId === deviceId);
        return !!device?.online && !this.devices.isUserControlled(deviceId);
      },
      handoffInProgress: (record) => !!record.handoff?.deviceId && this.devices.isUserControlled(record.handoff.deviceId),
      diagnostic: (error) => log.warn("task.failed", { ...errorFields(error) }),
      toolFailed: (taskId, toolName, error) => log.warn("task.tool.failed", { taskId, toolName, ...errorFields(error) }),
      prepare: async (record, signal) => {
        const scope = await this.channels.storedContext(record.channel);
        if (!scope) throw taskError(TASK_ERRORS.task_conversation_missing);
        const bot = this.host.account(scope.platform, scope.selfId!);
        if (!bot) throw taskError(TASK_ERRORS.task_bot_unavailable);
        const channel = await this.channels.resolve(scope);
        if (`${channel.conversation.currentSessionId()}.jsonl` !== record.session) throw taskError(TASK_ERRORS.task_session_archived);
        const chat = this.workerModel(record, scope);
        const imageProjection = new EphemeralImageProjectionStore();
        const nativeImageInput = resolveReadImagePolicy(chat, undefined, config.imageInput);
        const taskSource = record.source && taskSourceMatchesScope(record.source, scope) ? Object.freeze(structuredClone(record.source)) : undefined;
        const plugins = await this.agent.setup(scope, bot, {
          imageProjection,
          nativeImageInput,
          executionRole: record.kind,
          taskSource,
          rolePromptsManaged: true,
        });
        if (signal.aborted) {
          for (const plugin of plugins.reverse()) await plugin.stop?.();
          signal.throwIfAborted();
        }
        return {
          deviceId: this.devices.workspaceDevice(scope),
          currentDeviceId: () => this.devices.workspaceDevice(scope),
          modelRef: chat.fullId,
          modelLimit: chat.entry.limit,
          config: {
            model: chat.model,
            tools: declareBuiltinTools([createReadTool(channel.resources, nativeImageInput, imageProjection)], "core", scope.platform),
            // A task acts for the request that created it: its sensitive tools need that request to come from admins.
            toolBoundary: runtimeToolBoundary(
              { platform: scope.platform, kind: scope.type === "direct" ? "direct" : "group" },
              record.kind,
              ["task_report"],
              () => adminSource(scope, config.admins, taskSource),
            ),
            plugins: [createModelInputPlugin(chat.capabilities?.historyProjection ?? "default"), ...plugins],
            // A background task retries a failed model request like the chat does; without it one dropped
            // connection ended a task after dozens of steps (preview records, 2026-11-19).
            maxRetries: config.modelRetries,
          },
          release: async () => {
            imageProjection.clearAll();
          },
        };
      },
      notify: async (record) => {
        const scope = await this.taskScope(record);
        if (!scope) return "obsolete";
        const posted = await this.messenger.postAndReport(
          {
            ...taskEventBase(scope),
            eventType: "task.result",
            task: { id: record.id, status: record.status },
            text: `后台任务 ${record.id} 的结果（不是新的用户请求）：${JSON.stringify({ status: record.status, result: record.result, artifacts: record.artifacts, pauseReason: record.pauseReason, ...(record.handoff?.state === "pending" ? { handoff: record.handoff.instruction, handoffExpiry: "超过一天没有处理，任务会自动结束" } : {}) })}。判断是要告诉用户、接着推进，还是无需行动。已完成就把结果交给用户。没完成又没有被真正阻塞时（内部预算暂停、只完成一部分、能换方法解决的错误都不算阻塞），按已完成部分和剩余步骤接着推进：剩下一两步就自己做；还要连续跑多条命令、反复排查或多处核对的，用 task_create 委派，写清已完成的内容、剩余步骤和约束（比如只查看不改动），不要在这里自己一步步做完，也不重做已完成的部分。结果未知（status 为 unknown，或报告里有结果未确认的操作）时由你自己核实，不要让用户去核实：先查明实际状态（查询、看页面、文件或日志；步骤多就委派一个只做核实的任务），已经生效的不重做，没生效的接着推进，再把结论告诉用户。只有需要用户本人操作、缺少只有用户能提供的信息或需要新的授权时，才请用户处理。带 handoff 的结果是后台任务想请用户做的事，转达前先核对：它是不是委派的那件事，是不是真的只有用户能做（登录、验证码、扫码、实体操作、只有用户知道的信息）。你或新的后台任务能做的（打开开关或面板选项、查日志、装软件、改配置、换下载源），就用 task_control 的 cancel 结束那个等待中的任务（它做过的不会撤销），自己接着做或重新委派，不要转给用户。`,
          },
          { trigger: true, ifBusy: "defer", historyMode: "event" },
        );
        return posted.kind === "run" && posted.outcome?.delivered ? "delivered" : "unknown";
      },
      // User, 2026-11-20: 「超时/步数超了仅提醒主bot（主bot可以结束/延长/steer等），不强制结束」.
      overtime: async (record, progress) => {
        const scope = await this.taskScope(record);
        if (!scope) return;
        const about = rejectedTaskReportDraft(record.instruction.replace(/\s+/g, " ").slice(0, 80));
        await this.messenger.postAndReport(
          {
            ...taskEventBase(scope),
            eventType: "task.overtime",
            task: { id: record.id, status: record.status },
            text: `后台任务 ${record.id}（${record.kind}：${about}）已经超过预计的 ${record.timeLimitMinutes} 分钟，还在运行。这是超时提醒，不是新的用户请求，也不是任务结果。${progress}\n看一下它的进展再决定：还在有效推进就不用管，或用 task_control 的 extend 多给时间；方向不对就用 update 引导它；没有希望就用 cancel 结束，再按已完成的部分接着处理。不需要告诉用户；没有要做的就直接结束这一轮。`,
            historyNote: `后台任务 ${record.id} 超过了预计的 ${record.timeLimitMinutes} 分钟，当时还在运行。`,
          },
          { trigger: true, ifBusy: "defer", historyMode: "event" },
        );
      },
    };
  }

  private conversationAccess(): ConversationAccess {
    const access: ConversationAccess = {
      read: (context, options) => this.channels.readConversation(context, options),
      locate: async (context) => {
        const channel = await this.channels.resolve(context);
        return { channel: channelStorageDirectory(context), session: `${channel.conversation.currentSessionId()}.jsonl` };
      },
      recordSent: async (context, message) => {
        const channel = await this.channels.resolve(context);
        if (!context.selfId) throw new Error("missing_bot_identity");
        await channel.conversation.storage.append(
          createEntry(
            "platform-message",
            {
              ...message,
              platform: context.platform,
              selfId: context.selfId,
              channel: { id: context.channelId, type: context.type === "direct" ? 1 : 0 },
              user: { id: context.selfId, isBot: true },
            },
            { timestamp: message.timestamp },
          ),
        );
      },
      prompt: async (context) => {
        const bot = this.host.account(context.platform, context.selfId!);
        if (!bot) throw new Error("bot_unavailable");
        return (await this.runtimes.get(await this.channels.resolve(context), bot)).promptPreview();
      },
      interrupt: (context) => this.runtimes.interrupt(context),
      archive: async (request) => {
        const context = await this.channels.storedContext(request.channel);
        if (!context || isRetiredPlatform(context.platform)) throw new Error("conversation_not_found");
        // Manual WebUI archive starts fresh; automatic file rotation carries the verified regions.
        const current = await access.locate(context);
        if (current.session !== request.session) throw conversationError(CONVERSATION_ERRORS.conversation_changed);
        await this.tasks.cancelOrigin(request.channel, request.session);
        await this.runtimes.archive(context, true, request.session);
      },
    };
    return access;
  }

  /** The chat a task belongs to, while the conversation that created it is still the current one. */
  private async taskScope(record: Pick<TaskRecord, "channel" | "session">): Promise<ChannelContext | undefined> {
    const scope = await this.channels.storedContext(record.channel);
    if (!scope) return undefined;
    const channel = await this.channels.resolve(scope);
    return `${channel.conversation.currentSessionId()}.jsonl` === record.session ? scope : undefined;
  }
}

/** Where a task's event goes: the chat it was delegated from. */
function taskEventBase(scope: ChannelContext) {
  return {
    platform: scope.platform,
    selfId: scope.selfId!,
    timestamp: SYSTEM_CLOCK.now(),
    channel: {
      id: scope.channelId,
      type: scope.type === "direct" ? CHANNEL_TYPE.direct : CHANNEL_TYPE.text,
      ...(scope.type === "channel" ? { parentId: scope.guildId } : {}),
    },
    ...(scope.type === "direct" ? { user: { id: scope.userId } } : {}),
  };
}
