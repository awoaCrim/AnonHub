import type { AgentPlugin, EphemeralImageProjectionStore, NativeImageInputPolicy } from "@yesimbot/agent-runtime";
import type { ReplyTriggerConfig } from "@yesimbot/contracts/reply-triggers";
import { AppError, logger, type Logger } from "@yesimbot/foundation";

import type { ChatAccount } from "../accounts.js";
import type { ChannelContext } from "../channels/index.js";
import type { TaskSource } from "../tasks/source.js";
import { protectPluginTools } from "../tool-policy.js";
import type { Awaitable } from "../types.js";
import { AGENT_ERRORS } from "./errors.js";
import type { ImagePreviewCapability } from "./image-preview.js";
import type { ReplyStickerProvider } from "./reply.js";
import { fixedReplyEngine, defaultWillEngine, type WillEngine, type WillPlugin } from "./will.js";

type Disposer = () => void;

/** Stable character material for the main Agent, which authors the final reply. */
export interface MainAgentRoleProfile {
  readonly characterDefinition?: string;
  readonly roleInstructions?: string;
  /** Card-authored note placed after the conversation history, as CCv3 intends. */
  readonly postHistoryInstructions?: string;
}

export interface MainAgentRoleProvider {
  resolve(context: ChannelContext): Awaitable<MainAgentRoleProfile | undefined>;
}

export interface ChannelPluginSetupContext {
  readonly executionRole?: "main" | "computer" | "content" | "service";
  /** Validated host-captured task origin; never read from model instructions. */
  readonly taskSource?: TaskSource;
  readonly imageProjection: EphemeralImageProjectionStore;
  /** The selected execution model's native image route; absent never authorizes image projection. */
  readonly nativeImageInput?: NativeImageInputPolicy;
  /**
   * Core-owned read-before-send seam: reuse of the active image capability without duplicating
   * provider credentials or the ephemeral byte-retention policy. Absent means the channel has no
   * working image route, so a plugin must not claim it displayed any content.
   */
  readonly imagePreview?: ImagePreviewCapability;
  /** Core assembles this opted-in provider's role material in its frozen role section. */
  readonly rolePromptsManaged?: boolean;
  /**
   * Optional modern reply-delivery seam. A plugin registers one typed sticker provider (catalog,
   * exact prior-step evidence, private lease and real transport IDs) and receives a disposer. Core
   * never imports plugin storage or types; absence keeps standalone plugin behavior intact.
   */
  readonly replyDelivery?: ReplyDeliverySetupContext;
  /** Optional Core-owned boundary for tools that directly send content to the current channel. */
  readonly channelOutput?: ChannelOutputSetupContext;
}

export interface ChannelOutputSetupContext {
  readonly version: 1;
  readonly registerTools: (toolNames: readonly string[]) => Disposer;
}

export interface ReplyDeliverySetupContext {
  readonly version: 1;
  readonly ownership: "authored";
  readonly registerSticker: (provider: ReplyStickerProvider) => Disposer;
}

export interface ChannelPlugin {
  /** Stable plugin name, independent of runtime instance and tool names. */
  readonly id?: string;
  readonly roleProfile?: MainAgentRoleProvider;
  setup(context: ChannelContext, bot: ChatAccount, runtime?: ChannelPluginSetupContext): Awaitable<AgentPlugin | null>;
}

export class Agents {
  private readonly logger: Logger = logger("yesimbot.agents");

  private readonly plugins = new Set<ChannelPlugin>();
  private readonly willPlugins = new Set<WillPlugin>();
  private revisionValue = 0;

  private readonly replyTriggers?: ReplyTriggerConfig;
  /** Log levels follow the one logging configuration (convention 07). */
  public constructor(config: { replyTriggers?: ReplyTriggerConfig } = {}) {
    this.replyTriggers = config.replyTriggers;
  }

  public get revision(): number {
    return this.revisionValue;
  }

  public use(plugin: ChannelPlugin): Disposer {
    if (!this.plugins.has(plugin)) {
      this.plugins.add(plugin);
      this.revisionValue += 1;
    }
    return () => {
      if (this.plugins.delete(plugin)) this.revisionValue += 1;
    };
  }

  public will(plugin: WillPlugin): Disposer {
    if (!this.willPlugins.has(plugin)) {
      this.willPlugins.add(plugin);
      this.revisionValue += 1;
    }
    return () => {
      if (this.willPlugins.delete(plugin)) this.revisionValue += 1;
    };
  }

  /** Resolved before plugin setup. Never blend identities. */
  public async resolveRoleProfile(context: ChannelContext): Promise<MainAgentRoleProfile | undefined> {
    let selected: MainAgentRoleProfile | undefined;
    // Registration changes belong to the next snapshot, not the middle of an async resolution.
    for (const plugin of [...this.plugins]) {
      const profile = await plugin.roleProfile?.resolve(context);
      if (!profile?.characterDefinition?.trim() && !profile?.roleInstructions?.trim() && !profile?.postHistoryInstructions?.trim()) continue;
      if (selected) throw new AppError(AGENT_ERRORS.agent_role_conflict, { effect: "none" });
      selected = profile;
    }
    return selected;
  }

  public async setup(context: ChannelContext, bot: ChatAccount, runtime?: ChannelPluginSetupContext): Promise<AgentPlugin[]> {
    const initialized: AgentPlugin[] = [];
    try {
      for (const plugin of [...this.plugins]) {
        if (runtime?.executionRole && runtime.executionRole !== "main" && plugin.roleProfile) continue;
        const setup = await plugin.setup(
          context,
          bot,
          runtime ? { ...runtime, rolePromptsManaged: runtime.rolePromptsManaged === true && plugin.roleProfile !== undefined } : undefined,
        );
        if (!setup) continue;
        const kind = context.type === "direct" ? "direct" : "group";
        initialized.push(
          protectPluginTools(
            setup,
            { platform: context.platform, kind },
            plugin.id ?? setup.name,
            (tools) =>
              // A background task's prompt drops other tasks' tools by design; for the main agent this is a prompt to fix.
              runtime?.executionRole && runtime.executionRole !== "main"
                ? undefined
                : this.logger.info("agents.prompt_pruned", { plugin: plugin.id ?? setup.name, platform: context.platform, kind, tools }),
            runtime?.executionRole,
          ),
        );
      }
      return initialized;
    } catch (cause) {
      for (const plugin of initialized.reverse()) {
        try {
          await plugin.stop?.();
        } catch {}
      }
      throw cause;
    }
  }

  public async setupWill(context: ChannelContext): Promise<WillEngine> {
    const rules = this.replyTriggers;
    const fixed = rules?.platforms.includes(context.platform) ? fixedReplyEngine(rules) : undefined;
    const plugins = [...this.willPlugins].map((plugin, index) => ({ plugin, index }));
    plugins.sort((left, right) => left.plugin.priority - right.plugin.priority || left.index - right.index);
    this.logger.debug("agents.setup_will", {
      pluginCount: plugins.length,
      platform: context.platform,
      channelId: context.channelId,
    });
    for (const { plugin } of plugins) {
      if (plugin.match(context)) {
        const engine = await plugin.setup(context);
        this.logger.debug("agents.will_selected", { engine: engine.constructor?.name ?? "plugin", plugin: plugin.constructor?.name ?? "will-plugin" });
        // Adapter gates (notably WeChat auto-reply) must admit the input before fixed rules apply.
        if (fixed)
          return {
            decide: async (input, state) => ((await engine.decide(input, state)) === "trigger" ? fixed.decide(input, state) : "wait"),
            debug: fixed.debug,
          };
        return engine;
      }
    }
    this.logger.debug("agents.will_selected", { engine: "default" });
    return fixed ?? defaultWillEngine;
  }
}

export type { WillBatchDecision, WillDebug, WillEngine, WillPlugin, WillReservationOutcome, WillState } from "./will.js";

export {
  createImagePreviewCapability,
  type ImageDescribeRequest,
  type ImagePreviewCapability,
  type ImagePreviewFrame,
  type ImagePreviewRequest,
} from "./image-preview.js";

export {
  extractProtectedTokens,
  fingerprintReplyPhaseInput,
  normalizeReplyParts,
  preflightReplyPhase,
  projectDeliveredText,
  REPLY_MAX_PHASE_BYTES,
  REPLY_MAX_UNITS,
  ReplyCoordinator,
  validateReplyParts,
  type PreparedReplyUnit,
  type ReplyDeliveryNotice,
  type ReplyJournalWriter,
  type ReplyMode,
  type ReplyPart,
  type ReplyProofWriter,
  type ReplySendFailureNotice,
  type ReplyStickerCatalogEntry,
  type ReplyStickerFrame,
  type ReplyStickerLease,
  type ReplyStickerProvider,
  type ReplyStickerStatus,
  type ReplyStickerTransport,
  type ReplyStickerView,
} from "./reply.js";

export { createReplyTools, type ReplyToolSet, type ReplyToolsOptions } from "./reply-tools.js";
