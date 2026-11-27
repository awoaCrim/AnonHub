import type { AgentHistoryMode, AgentPlugin, EphemeralImageProjectionStore, EphemeralVideoProjectionStore } from "@yesimbot/agent-runtime";
import type { Clock } from "@yesimbot/foundation";
import type { LanguageModel, ToolSet } from "ai";

import type { ChatAccount } from "../accounts.js";
import type { MainAgentRoleProfile } from "../agents/index.js";
import type { ReplyStickerProvider } from "../agents/reply.js";
import type { ReadImagePolicy, ReadVideoPolicy } from "../agents/tools.js";
import type { WillEngine } from "../agents/will.js";
import type { Channel } from "../channels/index.js";
import type { Config } from "../config.js";
import type { MessageBatchPlugin } from "../message-batches/index.js";
import type { HistoryProjectionMode } from "../models/index.js";
import type { Tasks } from "../tasks/manager.js";

export type RuntimeResult =
  | { readonly kind: "wait"; readonly eventId: string }
  | { readonly kind: "join"; readonly eventId: string; readonly turnId: string }
  /** `done` settles when the turn finishes; delivery already happened inside `send_message`. `outcome`
   * settles at the same time with how it ended. */
  | { readonly kind: "run"; readonly eventId: string; readonly done: Promise<void>; readonly outcome?: Promise<TurnOutcome> };

export type PostOptions = {
  readonly trigger?: boolean;
  readonly ifBusy?: "defer" | "join" | "reject";
  readonly delivery?: "channel" | "silent";
  /**
   * The turn's process stays out of sight: no typing or activity in the chat. Unlike `delivery: "silent"`,
   * what it sends is still delivered (a silent heartbeat investigates quietly but may still speak).
   */
  readonly quiet?: boolean;
  /** Overrides the default event isolation for an explicitly posted turn. */
  readonly historyMode?: AgentHistoryMode;
  /** Observes the real start, after a deferred turn leaves the queue. Failures only log. */
  readonly onTurnStart?: (turn: { readonly turnId: string; readonly startedAt: string }) => void | Promise<void>;
};

/** How a started turn ended, and whether it sent anything to its own channel. */
export interface TurnOutcome {
  readonly status: "done" | "failed" | "aborted";
  readonly delivered: boolean;
}

export interface ChannelRuntimeOptions {
  readonly channel: Channel;
  /** The system clock when absent. */
  readonly clock?: Clock;
  readonly bot: ChatAccount;
  readonly will: WillEngine;
  readonly model: LanguageModel;
  readonly contextModelLimit?: { context: number; output: number };
  readonly resolveContextModelLimit?: (model: LanguageModel) => { context: number; output: number } | undefined;
  /** Provider-scoped request history projection; omitted models use the compatibility default. */
  readonly historyProjection?: HistoryProjectionMode;
  /** Directly projects current-turn persisted images when config and the primary model allow it. */
  readonly directImageInput?: boolean;
  /** Set by the Core capability gate; the Runtime never infers forced tool choice by itself. */
  readonly toolChoice?: "required";
  readonly providerTools?: ToolSet;
  readonly visionModel?: LanguageModel;
  readonly readImagePolicy: ReadImagePolicy;
  /** Resolved only from the primary model, explicit transport and the opt-in Core flag. */
  readonly readVideoPolicy?: Pick<ReadVideoPolicy, "mode">;
  readonly videoProjection?: EphemeralVideoProjectionStore;
  readonly imageProjection?: EphemeralImageProjectionStore;
  readonly config: Config;
  readonly tasks?: Tasks;
  readonly plugins: readonly AgentPlugin[];
  /** Resolved once before plugin setup; Core owns its stable prompt placement. */
  readonly roleProfile?: MainAgentRoleProfile;
  readonly messageBatch?: MessageBatchPlugin;
  /** Summarizes regions in the background; the main model when absent. Never used by the main agent. */
  readonly historianModel?: LanguageModel;
  readonly archiveMaxBytes?: number;
  /** Optional reply-delivery capability collected before runtime construction. */
  readonly sticker?: ReplyStickerProvider;
  /** Core-owned names of plugin tools that directly deliver content to the current channel. */
  readonly channelOutputTools?: ReadonlySet<string>;
  /** Bound registry/setup/model generation; checked at every modern await/transport boundary. */
  readonly replyStillCurrent?: () => boolean;
}
