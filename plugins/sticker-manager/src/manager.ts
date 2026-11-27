import { EphemeralImageProjectionStore, type AgentPlugin } from "@yesimbot/agent-runtime";
import { errorFields, logger, type Logger } from "@yesimbot/foundation";
import { protectPluginTools, toolAllowed } from "koishi-plugin-yesimbot/kernel";
import type { ChannelPluginSetupContext, ChannelResources, ChannelContext, ChatAccount, RuntimeIdentity } from "koishi-plugin-yesimbot/kernel";

import type { StickerConfig } from "./config.js";
import { StickerDeliveryService } from "./delivery.js";
import { StickerPreviewGate, StickerSendSlot } from "./preview-evidence.js";
import { createStickerPreviewTool } from "./preview-tool.js";
import { BotStickerSender } from "./sender.js";
import { projectStickerElements, projectStickerHistoryElements } from "./sticker-element.js";
import type { StickerStore } from "./store.js";
import { createStickerTools, stickerSendMessageBlockReason } from "./tools.js";
import { scopeKeyFor } from "./types.js";

type ConversationIdentity = Awaited<ReturnType<RuntimeIdentity["conversation"]>>;

/** What the plugin needs from the host: the channel resources and who is talking. */
export interface StickerHost {
  resources(scope: ChannelContext): Promise<ChannelResources>;
  conversation(scope: ChannelContext): Promise<ConversationIdentity>;
}

/** Which optional tools are eligible in this conversation; the prompt only mentions those. */
interface StickerPromptGrants {
  steal: boolean;
  manage: boolean;
}

export class StickerManager {
  public readonly id = "yesimbot-sticker-manager";

  private started = false;
  private capabilityRevisionValue = 0;
  private readonly logger: Logger = logger("yesimbot.sticker-manager");

  public constructor(
    public readonly config: StickerConfig,
    public readonly store: StickerStore,
    private readonly host: StickerHost,
  ) {}

  /** Opens the file store; the host registers this plugin with Core afterwards. */
  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.store.ensure();
      this.logger.info("sticker_manager.started");
    } catch (cause) {
      this.started = false;
      throw cause;
    }
  }

  public async setup(scope: ChannelContext, bot: ChatAccount, runtime?: ChannelPluginSetupContext): Promise<AgentPlugin | null> {
    if (!this.started) return null;
    const resources = await this.host.resources(scope);
    const conversation = await this.host.conversation({ ...scope, selfId: scope.selfId ?? bot.selfId });
    const granted = (name: string) => toolAllowed(conversation, { name, pluginId: this.id, contexts: ["direct", "group"] });
    return protectPluginTools(
      this.createAgentPlugin(scope, bot, resources, runtime, { steal: granted("sticker_steal"), manage: granted("sticker_manage") }),
      conversation,
      this.id,
    );
  }

  /** Registers one typed modern capability for this channel; the disposer is idempotent. */
  public registerDelivery(
    scope: ChannelContext,
    bot: ChatAccount,
    runtime: ChannelPluginSetupContext,
    delivery: StickerDeliveryService,
  ): (() => void) | undefined {
    const register = runtime.replyDelivery?.registerSticker;
    if (!register || runtime.replyDelivery?.version !== 1) return undefined;
    let disposed = false;
    let generation = 0;
    const getRevision = () => this.capabilityRevision;
    const revision = getRevision();
    const current = () => !disposed && getRevision() === revision;
    const allowed = async (name: string) => {
      const conversation = await this.host.conversation({ ...scope, selfId: scope.selfId ?? bot.selfId });
      return toolAllowed(conversation, { name, pluginId: this.id, contexts: ["direct", "group"] });
    };
    const dispose = register({
      get revision() {
        return getRevision() + generation;
      },
      status: (turnId) => (current() ? delivery.status(turnId) : "unavailable"),
      catalog: async () => (current() && (await allowed("sticker_search")) ? delivery.catalog() : []),
      view: async (turnId, messages) => (current() && (await allowed("sticker_send")) ? delivery.view(turnId, messages) : undefined),
      isViewCurrent: (view, turnId) => current() && delivery.isViewCurrent(view, turnId),
      preflight: async (input) =>
        current() && (await allowed("sticker_send"))
          ? delivery.preflight({ ...input, stillAllowed: () => current() && (input.stillAllowed?.() ?? true) })
          : Promise.resolve({ error: "sticker_capability_retired" }),
    });
    return () => {
      if (disposed) return;
      disposed = true;
      generation++;
      dispose();
    };
  }

  private createAgentPlugin(
    scope: ChannelContext,
    bot: ChatAccount,
    resources: ChannelResources,
    runtime: ChannelPluginSetupContext | undefined,
    granted: StickerPromptGrants = { steal: false, manage: false },
  ): AgentPlugin {
    const artifactIds = new Map<string, string>();
    const sendSlot = new StickerSendSlot();
    const previewGate = new StickerPreviewGate();
    const scopeKey = scopeKeyFor(scope, this.config);
    const sender = new BotStickerSender(bot, scope);
    const revision = this.capabilityRevision;
    let retired = false;
    let activeTurn: { id: string } | undefined;
    let closedTurn: string | undefined;
    const captureTurn = (turnId: string) => {
      const captured = activeTurn;
      return () => !retired && this.capabilityRevision === revision && !!captured && captured.id === turnId && activeTurn === captured;
    };
    const delivery = new StickerDeliveryService({
      store: this.store,
      sender,
      scope,
      config: this.config,
      sendSlot,
      previewGate,
      captureTurn,
      onUsageWarning: (stickerId, cause) => this.logger.warn("sticker_manager.usage_update_failed", { stickerId, ...errorFields(cause) }),
    });
    const disposeDelivery = this.registerDelivery(scope, bot, runtime ?? { imageProjection: new EphemeralImageProjectionStore() }, delivery);
    return {
      name: "sticker-manager",
      tools: () => [
        createStickerPreviewTool({
          store: this.store,
          config: this.config,
          scopeKey,
          // The Core-owned store keeps preview bytes visible for the bounded live turn and out of
          // durable history; without it a preview has nothing to project.
          projection: runtime?.imageProjection ?? new EphemeralImageProjectionStore(),
          previewCapability: runtime?.imagePreview,
          gate: previewGate,
          captureTurn,
        }),
        ...createStickerTools({
          store: this.store,
          assets: resources.assets,
          scope,
          config: this.config,
          captureTurn,
        }),
      ],
      beforeToolCall: (call) => {
        // A legacy sticker artifact URI or a bare <sticker/> element in send_message would deliver
        // unread bytes through the text-resource path, bypassing exact-record admission and the quota.
        if (call.toolName !== "send_message") return;
        const reason = stickerSendMessageBlockReason(call.args);
        return reason ? { type: "block", reason } : undefined;
      },
      onTurnFinish: (_result, context) => {
        if (activeTurn?.id === context.turnId) {
          activeTurn = undefined;
          closedTurn = context.turnId;
        }
        delivery.finishTurn(context.turnId);
      },
      stop: () => {
        retired = true;
        activeTurn = undefined;
        disposeDelivery?.();
        delivery.stop();
      },
      prepareStep: (messages, context) => {
        if (retired || this.capabilityRevision !== revision || closedTurn === context.turnId) return messages;
        if (activeTurn?.id !== context.turnId) {
          if (activeTurn) delivery.finishTurn(activeTurn.id);
          activeTurn = { id: context.turnId };
        }
        return messages;
      },
      onAppend: (entries) =>
        projectStickerElements(entries, {
          store: this.store,
          artifacts: resources.artifacts,
          scopeKey,
          artifactIds,
        }),
      transformEntries: (entries) =>
        projectStickerHistoryElements(entries, {
          store: this.store,
          artifacts: resources.artifacts,
          scopeKey,
          artifactIds,
        }),
      appendSystemPrompt: () => formatStickerPrompt(this.config, granted),
    } satisfies AgentPlugin;
  }

  private get capabilityRevision(): number {
    return this.capabilityRevisionValue;
  }

  public async stop(): Promise<void> {
    this.started = false;
    this.capabilityRevisionValue += 1;
    this.logger.info("sticker_manager.stopped");
  }
}

function formatStickerPrompt(config: StickerConfig, granted: StickerPromptGrants): string {
  return [
    "表情包可按当前语境自主选用；需要时用 sticker_search 查询当前库（不带条件返回分类和数量），具体用法见工具说明。",
    "发送使用 send_message 的 sticker parts。",
    ...(granted.steal ? ["sticker_steal 可收藏已实际看过的聊天图片。"] : []),
    ...(granted.manage ? ["sticker_manage 可整理库内分类和单张记录。"] : []),
    ...(config.tagMode ? ["sticker_search 不带条件时也会列出实验性标签及数量。"] : []),
  ].join("\n");
}
