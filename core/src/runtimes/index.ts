import { EphemeralImageProjectionStore, EphemeralVideoProjectionStore, type NativeImageInputPolicy } from "@yesimbot/agent-runtime";
import { AppError, logger, serialize, type Logger } from "@yesimbot/foundation";

import type { ChatAccount, SameAccount } from "../accounts.js";
import { createImagePreviewCapability } from "../agents/image-preview.js";
import { Agents, type ReplyStickerProvider } from "../agents/index.js";
import type { ReadVideoPolicy } from "../agents/tools.js";
import type { Channel, Channels } from "../channels/index.js";
import { type ChannelContext, type ChannelKey, deriveChannelKey } from "../channels/index.js";
import type { Config } from "../config.js";
import { CONVERSATION_ERRORS, conversationError } from "../conversations/errors.js";
import type { CoreEventBus } from "../events.js";
import { MessageBatchRegistry } from "../message-batches/index.js";
import { MODEL_ERRORS, type ChatModelRef, ModelService } from "../models/index.js";
import type { ChannelOverrides } from "../overrides.js";
import type { Tasks } from "../tasks/manager.js";
import { ChannelRuntime } from "./channel.js";
import { RUNTIME_ERRORS } from "./errors.js";

export class Runtimes {
  private readonly logger: Logger;
  private readonly runtimes = new Map<string, ChannelRuntime>();
  private readonly agentRevisions = new Map<string, number>();
  private readonly messageRevisions = new Map<string, number>();
  private readonly modelRevisions = new Map<string, number | undefined>();
  private stopped = false;
  private stopTask: Promise<void> | undefined;
  private readonly messageRevisionDisposer: () => void;
  private readonly modelRevisionDisposer: () => void;

  public constructor(
    private readonly events: CoreEventBus,
    private readonly channels: Channels,
    private readonly model: ModelService,
    private readonly config: Config,
    private readonly agents: Agents,
    private readonly messageBatches: MessageBatchRegistry = new MessageBatchRegistry(),
    private readonly overrides?: Pick<ChannelOverrides, "get">,
    private readonly tasks?: Tasks,
    private readonly sameAccount: SameAccount = (left, right) => left === right,
  ) {
    this.logger = logger("yesimbot.runtimes");
    this.messageRevisionDisposer = this.messageBatches.onRevision((revision) => {
      void this.invalidateMessageRuntimes(revision);
    });
    this.modelRevisionDisposer = events.on("yesimbot/model-registry-changed", (revision) => {
      void this.invalidateModelRuntimes(revision);
    });
  }

  public async get(channel: Channel, bot: ChatAccount): Promise<ChannelRuntime> {
    const key = runtimeKey(channel.context);
    let value!: ChannelRuntime;
    let retry = false;
    await serialize(key, async () => {
      this.assertOpen();
      const current = this.runtimes.get(key);
      const agentRevision = this.agents.revision;
      const currentRevision = this.agentRevisions.get(key);
      const messageRevision = this.messageBatches.revision;
      const currentMessageRevision = this.messageRevisions.get(key);
      const modelRevision = this.model.revision;
      const currentModelRevision = this.modelRevisions.get(key);
      const sameBot = current ? this.sameAccount(current.account, bot) && current.account.selfId === bot.selfId : false;
      if (current && sameBot && currentRevision === agentRevision && currentMessageRevision === messageRevision && currentModelRevision === modelRevision) {
        value = current;
        return;
      }
      if (current) {
        const reasons = [
          ...(sameBot ? [] : ["bot"]),
          ...(currentRevision === agentRevision ? [] : ["agent_revision"]),
          ...(currentMessageRevision === messageRevision ? [] : ["message_revision"]),
          ...(currentModelRevision === modelRevision ? [] : ["model_revision"]),
        ];
        this.logger.warn("runtimes.get.recreate", {
          key,
          reasons,
          oldSelfId: current.selfId,
          newSelfId: bot.selfId,
          oldAgentRevision: currentRevision,
          newAgentRevision: agentRevision,
          oldMessageRevision: currentMessageRevision,
          newMessageRevision: messageRevision,
          oldModelRevision: currentModelRevision,
          newModelRevision: modelRevision,
        });
        await current.stop();
      }
      const chatModelId = this.chatModelFor(channel.context);
      const chat = this.model.resolveChatModel(chatModelId, channel.context);
      const toolChoice = resolveToolChoice(chat);
      if (toolChoice === undefined) {
        this.logger.debug("runtimes.tool_choice_compatible", {
          fullId: chat.fullId,
          provider: chat.providerId,
          model: chat.modelId,
          toolCallCapability: chat.entry.toolCall,
          providerToolCount: Object.keys(chat.tools ?? {}).length,
        });
      }
      const summarizer = this.resolveHistorianModel(chat, channel.context);
      const configuredThinking = summarizer.entry.thinkingLevel;
      const historianModel = this.model.resolveChatModel(summarizer.fullId, channel.context, {
        thinkingLevel: configuredThinking === "off" || configuredThinking === "minimal" || configuredThinking === "low" ? configuredThinking : "low",
      }).model;
      const vision = this.resolveVision(channel.context);
      const imageProjection = new EphemeralImageProjectionStore();
      const readImagePolicy = resolveReadImagePolicy(chat, vision, this.config.imageInput);
      const readVideoPolicy = resolveReadVideoPolicy(chat, this.config.videoInput === true);
      const videoProjection = readVideoPolicy.mode === "native" ? new EphemeralVideoProjectionStore() : undefined;
      const registriesCurrent = () =>
        !this.stopped &&
        this.agents.revision === agentRevision &&
        this.messageBatches.revision === messageRevision &&
        this.model.revision === modelRevision &&
        this.chatModelFor(channel.context) === chatModelId;
      // Records persist guild/channel contexts without the bot; plugins need it.
      const botContext: ChannelContext = channel.context.type === "direct" ? channel.context : { ...channel.context, selfId: bot.selfId };
      const roleProfile = await this.agents.resolveRoleProfile(botContext);
      if (!registriesCurrent()) {
        retry = true;
        return;
      }
      const will = await this.agents.setupWill(botContext);
      // The channel-local holder collects exactly one typed sticker provider before the runtime is
      // frozen. Capability generation changes invalidate prepared phases.
      const channelOutputTools = new Set<string>();
      const channelOutputRegistrations = new Map<string, number>();
      const registerChannelOutputTools = (toolNames: readonly string[]) => {
        const registered = [...new Set(toolNames.filter((toolName) => toolName.trim().length > 0))];
        for (const toolName of registered) {
          channelOutputRegistrations.set(toolName, (channelOutputRegistrations.get(toolName) ?? 0) + 1);
          channelOutputTools.add(toolName);
        }
        let disposed = false;
        return () => {
          if (disposed) return;
          disposed = true;
          for (const toolName of registered) {
            const count = channelOutputRegistrations.get(toolName) ?? 0;
            if (count <= 1) {
              channelOutputRegistrations.delete(toolName);
              channelOutputTools.delete(toolName);
            } else {
              channelOutputRegistrations.set(toolName, count - 1);
            }
          }
        };
      };
      let providerGeneration = 0;
      let frozen = false;
      let stickerProvider: ReplyStickerProvider | undefined;
      const plugins = await this.agents
        .setup(botContext, bot, {
          imageProjection,
          nativeImageInput: readImagePolicy,
          imagePreview: createImagePreviewCapability({ policy: readImagePolicy, projection: imageProjection }),
          rolePromptsManaged: true,
          replyDelivery: {
            version: 1 as const,
            ownership: "authored" as const,
            registerSticker: (provider: ReplyStickerProvider) => {
              if (frozen || stickerProvider) throw new AppError(RUNTIME_ERRORS.runtime_setup_conflict, { effect: "none", detail: "sticker delivery" });
              stickerProvider = provider;
              providerGeneration++;
              return () => {
                if (stickerProvider === provider) {
                  stickerProvider = undefined;
                  providerGeneration++;
                }
              };
            },
          },
          channelOutput: {
            version: 1 as const,
            registerTools: registerChannelOutputTools,
          },
        })
        .catch((cause) => {
          frozen = true;
          stickerProvider = undefined;
          providerGeneration++;
          throw cause;
        });
      frozen = true;
      const boundSticker = stickerProvider;
      const selectedProviderGeneration = providerGeneration;
      const stillCurrent = () => registriesCurrent() && providerGeneration === selectedProviderGeneration && stickerProvider === boundSticker;
      // Setup may await while any owning registry changes. Retire before init can write history.
      if (!stillCurrent()) {
        for (const plugin of plugins.reverse()) {
          try {
            await plugin.stop?.();
          } catch {}
        }
        retry = true;
        return;
      }
      const runtime = new ChannelRuntime(this.events, {
        channel,
        bot,
        will,
        model: chat.model,
        contextModelLimit: chat.entry.limit,
        resolveContextModelLimit: (model) => this.model.contextLimit(model),
        historyProjection: chat.capabilities?.historyProjection ?? "default",
        directImageInput: this.config.imageInput && resolvePrimaryImageInput(chat),
        toolChoice,
        historianModel,
        providerTools: chat.tools,
        visionModel: vision?.model,
        readImagePolicy,
        readVideoPolicy,
        ...(videoProjection ? { videoProjection } : {}),
        imageProjection,
        config: this.config,
        tasks: this.tasks,
        plugins,
        roleProfile,
        replyStillCurrent: stillCurrent,
        ...(stickerProvider ? { sticker: stickerProvider } : {}),
        channelOutputTools,
        messageBatch: this.messageBatches.select(channel.context),
        archiveMaxBytes: this.config.session.archive.maxKB * 1024,
      });
      try {
        await runtime.init();
      } catch (cause) {
        await runtime.stop().catch(() => undefined);
        throw cause;
      }
      // Already-persisted history is canonical; retrying never rolls it back.
      if (!stillCurrent()) {
        await runtime.stop();
        retry = true;
        return;
      }
      if (this.agents.revision !== agentRevision) {
        this.logger.warn("runtimes.get.agent_revision_changed", { key, selectedRevision: agentRevision, latestRevision: this.agents.revision });
        await runtime.stop();
        retry = true;
        return;
      }
      const latestMessageRevision = this.messageBatches.revision;
      if (latestMessageRevision !== messageRevision) {
        this.logger.warn("runtimes.get.message_revision_changed", { key, selectedRevision: messageRevision, latestRevision: latestMessageRevision });
        await runtime.stop();
        retry = true;
        return;
      }
      this.runtimes.set(key, runtime);
      this.agentRevisions.set(key, agentRevision);
      this.messageRevisions.set(key, messageRevision);
      this.modelRevisions.set(key, modelRevision);
      this.logger.debug("runtimes.get.created", { key, selfId: bot.selfId, agentRevision, messageRevision, modelRevision, runtimeCount: this.runtimeCount() });
      value = runtime;
    });
    if (retry) return this.get(channel, bot);
    return value;
  }

  /** The conversation's own reply model while it is registered, otherwise the configured one; "" when neither is set (resolving it fails). */
  public chatModelFor(context: ChannelContext): string {
    const own = this.overrides?.get(context)?.chatModel;
    return own && this.model.listChatModels().some((model) => model.fullId === own) ? own : (this.config.chatModel ?? "");
  }

  /** Drops one conversation's live runtime (history stays); its next turn builds a new one. */
  public async release(ctx: ChannelContext): Promise<void> {
    const key = runtimeKey(ctx);
    await serialize(key, async () => {
      const current = this.runtimes.get(key);
      if (current) {
        this.logger.debug("runtimes.release", { key });
        await current.stop();
      }
      this.runtimes.delete(key);
      this.agentRevisions.delete(key);
      this.messageRevisions.delete(key);
      this.modelRevisions.delete(key);
    });
  }

  public async reset(ctx: ChannelContext): Promise<void> {
    const key = runtimeKey(ctx);
    await serialize(key, async () => {
      const current = this.runtimes.get(key);
      if (current) {
        this.logger.warn("runtimes.reset", { key });
        await current.stop();
      }
      this.runtimes.delete(key);
      this.agentRevisions.delete(key);
      this.messageRevisions.delete(key);
      this.modelRevisions.delete(key);
      await this.channels.reset(ctx);
    });
  }

  public stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopped = true;
    this.logger.debug("runtimes.stop", { runtimeCount: this.runtimes.size });
    this.messageRevisionDisposer();
    this.modelRevisionDisposer();
    this.stopTask = Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.stop())).then(() => {
      this.runtimes.clear();
      this.agentRevisions.clear();
      this.messageRevisions.clear();
      this.modelRevisions.clear();
    });
    return this.stopTask;
  }

  /** Stop this conversation's running turn, if any (a user's stop button). Nothing starts a runtime here. */
  public async interrupt(ctx: ChannelContext): Promise<boolean> {
    return (await this.runtimes.get(runtimeKey(ctx))?.interruptActiveTurn()) ?? false;
  }

  public async archive(ctx: ChannelContext, noSummary = false, expectedSession?: string): Promise<string> {
    const key = runtimeKey(ctx);
    await serialize(key, async () => {
      const channel = await this.channels.resolve(ctx);
      const checkSession = () => {
        if (expectedSession !== undefined && `${channel.conversation.currentSessionId()}.jsonl` !== expectedSession)
          throw conversationError(CONVERSATION_ERRORS.conversation_changed);
      };
      checkSession();
      if (expectedSession !== undefined && !(await channel.conversation.storage.read()).length) throw conversationError(CONVERSATION_ERRORS.conversation_empty);
      const runtime = this.runtimes.get(key);
      if (runtime) {
        this.logger.warn("runtimes.archive", { key });
        await runtime.stop();
      }
      this.runtimes.delete(key);
      this.agentRevisions.delete(key);
      this.messageRevisions.delete(key);
      this.modelRevisions.delete(key);
      // Stopping an active turn may settle an automatic archive. Never rotate its replacement.
      checkSession();
      await channel.conversation.archive(noSummary);
    });
    return "已归档当前会话。";
  }

  public clear(ctx: ChannelContext): Promise<void> {
    return this.reset(ctx);
  }

  public async list(ctx: ChannelContext): Promise<string> {
    const sessions = await (await this.channels.resolve(ctx)).conversation.list();
    return sessions.length ? sessions.map((session) => `${session.isActive ? "→ " : "  "}${session.filename}`).join("\n") : "无会话记录。";
  }

  /**
   * History summaries use the auxiliary model (user, 2026-11-21: no separate setting). Unlike other auxiliary work they
   * stay on the chat model when none is usable, so a long conversation can still be summarized.
   */
  private resolveHistorianModel(fallback: ChatModelRef, context: ChannelContext): ChatModelRef {
    if (!this.config.auxiliaryModel?.trim()) return fallback;
    try {
      return this.model.resolveAuxiliaryModel("history-summary", context);
    } catch {
      return fallback;
    }
  }

  private resolveVision(context: ChannelContext) {
    const configured = this.config.visionModel?.trim();
    if (!configured) return undefined;
    try {
      const vision = this.model.resolveChatModel(configured, context);
      const imageCapable = vision.entry.modalities?.input?.includes("image") ?? false;
      this.logger.debug("runtimes.vision_model_resolved", {
        route: "vision",
        source: "config.visionModel",
        fullId: vision.fullId,
        provider: vision.providerId,
        model: vision.modelId,
        imageCapable,
      });
      if (imageCapable) return vision;
      this.logger.warn("runtimes.vision_model_not_image_capable", {
        route: "vision",
        source: "config.visionModel",
        fullId: vision.fullId,
      });
      return undefined;
    } catch (cause) {
      const code = cause instanceof AppError ? cause.code : MODEL_ERRORS.model_not_found;
      this.logger.warn("runtimes.vision_model_unavailable", {
        route: "vision",
        source: "config.visionModel",
        model: configured,
        code,
      });
      return undefined;
    }
  }

  private async invalidateMessageRuntimes(revision: number): Promise<void> {
    if (this.stopped) return;
    await Promise.all(
      [...this.runtimes.keys()].map((key) =>
        serialize(key, async () => {
          const currentRevision = this.messageRevisions.get(key);
          if (currentRevision === undefined || currentRevision >= revision) return;
          const runtime = this.runtimes.get(key);
          if (runtime) {
            this.logger.warn("runtimes.invalidate_message", { key, currentRevision, newRevision: revision });
            await runtime.stop();
          }
          this.runtimes.delete(key);
          this.agentRevisions.delete(key);
          this.messageRevisions.delete(key);
          this.modelRevisions.delete(key);
        }),
      ),
    );
  }

  private async invalidateModelRuntimes(revision: number): Promise<void> {
    if (this.stopped) return;
    await Promise.all(
      [...this.runtimes.keys()].map((key) =>
        serialize(key, async () => {
          const currentRevision = this.modelRevisions.get(key);
          if (currentRevision === undefined || currentRevision >= revision) return;
          const runtime = this.runtimes.get(key);
          if (runtime) {
            this.logger.warn("runtimes.invalidate_model", { key, currentRevision, newRevision: revision });
            await runtime.stop();
          }
          this.runtimes.delete(key);
          this.agentRevisions.delete(key);
          this.messageRevisions.delete(key);
          this.modelRevisions.delete(key);
        }),
      ),
    );
  }

  private assertOpen(): void {
    if (this.stopped) throw new AppError(RUNTIME_ERRORS.runtime_stopped, { effect: "none" });
  }

  private runtimeCount(): number {
    return [...this.runtimes.values()].length;
  }
}

/**
 * Capability gate for provider-side forced tool calling. Only a model whose resolved config
 * explicitly declares `toolCall: true` is forced, and only when no provider-defined tool is mixed
 * in: provider adapters may drop Core function declarations when both are present, and an unknown
 * capability must never be guessed from the provider name. When this returns `undefined` the turn
 * still requires a terminal tool - it just cannot rely on the provider to force one.
 */
export function resolveToolChoice(chat: Pick<ChatModelRef, "entry" | "tools">): "required" | undefined {
  if (chat.entry.toolCall !== true) return undefined;
  if (chat.tools && Object.keys(chat.tools).length > 0) return undefined;
  return "required";
}

export function resolvePrimaryImageInput(primary: ChatModelRef): boolean {
  const inputs = primary.entry.modalities?.input;
  if (inputs?.includes("image")) return true;
  // A video selection does not declare the model text/video-only.
  // Unknown image metadata can use the adapter's native route; explicit exclusions win.
  return (inputs === undefined || primary.inputModalitiesSource === "selection") && primary.capabilities.imageToolResult === "native";
}

/** Reading must deliver pixels to the execution model; a separate description is not a read. */
export function resolveReadImagePolicy(primary: ChatModelRef, _vision: ChatModelRef | undefined, imageInput: boolean): NativeImageInputPolicy {
  if (imageInput && resolvePrimaryImageInput(primary) && primary.capabilities.imageToolResult === "native") {
    return {
      mode: "native",
      ...(primary.capabilities.imageToolResultMediaTypes === undefined ? {} : { nativeMediaTypes: primary.capabilities.imageToolResultMediaTypes }),
    };
  }

  return { mode: "unavailable" };
}

// Model modalities and adapter transport are capabilities, not additional operator switches.
export function resolveReadVideoPolicy(primary: ChatModelRef, videoInput: boolean): Pick<ReadVideoPolicy, "mode"> {
  const native = videoInput && (primary.entry.modalities?.input?.includes("video") ?? false) && primary.capabilities.videoInput === "native";
  return { mode: native ? "native" : "unavailable" };
}

function runtimeKey(ctx: ChannelContext): ChannelKey {
  return deriveChannelKey(ctx);
}

export { ChannelRuntime } from "./channel.js";
export type { RuntimeResult, PostOptions } from "./types.js";
