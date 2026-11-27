import { systemClock } from "@yesimbot/foundation";
import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";

import { createRandomId } from "./id.js";
import type { AgentMessage } from "./message.js";
import { modelFailureInfo, modelFailureMessage, type ModelFailure } from "./model-errors.js";
import type { ToolJournalNoticeCode } from "./tool-journal.js";

/** Default time for callers that pass none; Core passes its own. */
const clock = systemClock();

export type MessageAppendedEvent = { type: "message.appended"; message: AgentMessage } | ({ type: "message.appended"; message: AgentMessage } & TurnScoped);

export type AgentInternalEventInit =
  | AgentInitEvent
  | AgentStopEvent
  | AgentErrorEvent
  | TurnQueuedEvent
  | TurnStartEvent
  | TurnStepEvent
  | TurnDeltaEvent
  | TurnDoneEvent
  | TurnFailedEvent
  | TurnAbortedEvent
  | MessageAppendedEvent
  | ToolStartEvent
  | ToolDoneEvent
  | ToolFailedEvent
  | ToolBlockedEvent
  | PluginErrorEvent
  | PluginDisabledEvent
  | WillDecisionEvent;

export type AgentInternalEvent<T extends AgentInternalEventInit = AgentInternalEventInit> = T & AgentInternalEventMeta;

export type AgentCustomChannelEvent<T extends keyof AgentCustomChannelEvents = keyof AgentCustomChannelEvents> = AgentCustomChannelEvents[T];

export interface AgentCustomChannelEvents {
  internal: AgentInternalEvent;
  stream: TextStreamPart<ToolSet>;
}

export interface AgentDiagnostic {
  name: string;
  message: string;
  cause?: string;
  modelFailure?: ModelFailure;
  status?: number;
  requestId?: string;
}

export interface AgentInitEvent {
  type: "agent.init";
}

export interface AgentStopEvent {
  type: "agent.stop";
}

export interface AgentErrorEvent {
  type: "agent.error";
  error: AgentDiagnostic;
}

export interface TurnQueuedEvent extends TurnScoped {
  type: "turn.queued";
}

export interface TurnStartEvent extends TurnScoped {
  type: "turn.start";
}

export interface TurnStepEvent extends TurnScoped {
  type: "turn.step";
  step: number;
  usage?: Partial<LanguageModelUsage>;
  finishReason?: string;
  reasoningText?: string;
}

export interface TurnDeltaEvent extends TurnScoped {
  type: "turn.delta";
  delta: string;
}

export interface TurnDoneEvent extends TurnScoped {
  type: "turn.done";
}

export interface TurnFailedEvent extends TurnScoped {
  type: "turn.failed";
  error: AgentDiagnostic;
}

export interface TurnAbortedEvent extends TurnScoped {
  type: "turn.aborted";
  reason?: string;
}

export interface ToolStartEvent extends TurnScoped {
  type: "tool.start";
  toolName: string;
  toolCallId?: string;
  args?: unknown;
}

export interface ToolDoneEvent extends TurnScoped {
  type: "tool.done";
  toolName: string;
  toolCallId?: string;
  result?: unknown;
}

export interface ToolFailedEvent extends TurnScoped {
  type: "tool.failed";
  toolName: string;
  toolCallId?: string;
  error: AgentDiagnostic;
  args?: unknown;
}

export interface ToolBlockedEvent extends TurnScoped {
  type: "tool.blocked";
  toolName: string;
  toolCallId?: string;
  reason?: string;
  /** Durable execution admission/recovery outcome, when a tool journal blocked this call. */
  journalCode?: ToolJournalNoticeCode;
  executionStatus?: "unknown" | "completed" | "not_started";
  automaticReplayBlocked?: boolean;
}

export interface PluginErrorEvent {
  type: "plugin.error";
  plugin: string;
  error: AgentDiagnostic;
}

export interface PluginDisabledEvent {
  type: "plugin.disabled";
  plugin: string;
  reason?: AgentDiagnostic;
}

export interface WillDecisionEvent {
  type: "will.decision";
  eventId: string;
  decision: "wait" | "trigger";
  debug?: unknown;
}

export interface AgentInternalEventMeta {
  id: string;
  timestamp: number;
}

interface TurnScoped {
  turnId: string;
}

export function createDiagnostic(error: unknown): AgentDiagnostic {
  const failure = modelFailureInfo(error);
  if (failure)
    return {
      name: "ModelRequestError",
      message: modelFailureMessage(failure),
      modelFailure: failure.kind,
      ...(failure.status === undefined ? {} : { status: failure.status }),
      ...(failure.requestId ? { requestId: failure.requestId } : {}),
    };
  if (error instanceof Error) {
    return { name: error.name, message: error.message, cause: formatDiagnosticCause(error.cause) };
  }

  return { name: "UnknownError", message: String(error) };
}

export function createInternalEvent<T extends AgentInternalEventInit>(event: T): AgentInternalEvent<T> {
  return { id: createRandomId(), timestamp: clock.now(), ...event };
}

function formatDiagnosticCause(cause: unknown): string | undefined {
  if (cause === undefined) {
    return undefined;
  }

  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }

  return String(cause);
}
