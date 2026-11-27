import { asSchema, safeValidateTypes } from "@ai-sdk/provider-utils";
import {
  APICallError,
  isLoopFinished,
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
  type LanguageModelUsage,
  type ModelMessage,
  type StopCondition,
  type SystemModelMessage,
  type ToolSet,
} from "ai";

import { AgentChannel, createAgentChannel } from "./channel.js";
import type { AgentEntry } from "./entry.js";
import { createEventEntry, createMessageEntry } from "./entry.js";
import { formatErrorCause, ToolConflictError, AgentProtocolError, type AgentProtocolViolation } from "./errors.js";
import type { AgentInternalEvent, AgentInternalEventInit } from "./event.js";
import { createDiagnostic, createInternalEvent } from "./event.js";
import { sanitizeAgentEntriesForPersistence } from "./media.js";
import type { AgentMessage } from "./message.js";
import { buildModelMessages, createAssistantMessage, createToolMessage } from "./message.js";
import { classifyModelError } from "./model-errors.js";
import { consumeModelRetry, modelRequestContextMiddleware } from "./model-request-context.js";
import { bufferModelStream, IncompleteModelStreamError } from "./model-stream.js";
import type { AgentPlugin, AgentPluginRuntime, SystemPromptAppend, SystemPromptSource, ToolHookContext } from "./plugin.js";
import { createPluginHost, normalizeSystemPromptAppend } from "./plugin.js";
import type { AgentRequestProjection } from "./request-projection.js";
import type { AgentState } from "./state.js";
import { AgentStateManager, createStateManager } from "./state.js";
import type { AgentStorage } from "./storage.js";
import { createMemoryStorage } from "./storage.js";
import { ToolJournalNotice, type ToolJournal } from "./tool-journal.js";
import { toolPreambleMiddleware } from "./tool-preamble.js";
import type { AgentToolExecuteContext } from "./tools.js";
import { AgentTool, AgentToolSet, compiledInputSchema, toAiToolSet } from "./tools.js";
import { createTurnQueue, TurnResult, type AgentHistoryMode, type AgentWaitOptions, type TurnRequest } from "./turn.js";

const DEFAULT_MAX_STEPS = 100;

const MAX_MODEL_RETRIES = 5;

const TERMINAL_TOOL_RECOVERY_PROMPT =
  "The previous step used a non-terminal tool and stopped before completing the turn. Continue now by calling exactly one available terminal tool. Use finish when available; send_message only sends a message and does not end the turn. Do not call an intermediate tool and do not reply with assistant text; this is an internal repair step.";

/** Steps the repair request after the step limit may take: a report a pre-send review may hold back
 * once, its resubmission, the terminal call, and one spare. */
const STEP_LIMIT_RECOVERY_STEPS = 4;

/** Check at every provider invocation, including zero-retry requests after SDK awaits. */
const MODEL_REQUEST_ABORT_MIDDLEWARE: LanguageModelMiddleware = {
  specificationVersion: "v3",
  wrapGenerate: ({ doGenerate, params }) => {
    throwIfAborted(params.abortSignal);
    return doGenerate();
  },
  wrapStream: ({ doStream, params }) => {
    throwIfAborted(params.abortSignal);
    return doStream();
  },
};

const TRANSIENT_MODEL_ERROR_MIDDLEWARE: LanguageModelMiddleware = {
  specificationVersion: "v3",
  async wrapGenerate({ doGenerate }) {
    try {
      return await doGenerate();
    } catch (cause) {
      throw filterRetryableModelError(cause);
    }
  },
  async wrapStream({ doStream, params }) {
    try {
      const response = await doStream();
      // Provider-side tools may already have effects before any stream part reaches us.
      if (params.tools?.some((tool) => tool.type === "provider")) return response;
      return await bufferModelStream(response, params.abortSignal);
    } catch (cause) {
      if (!APICallError.isInstance(cause) && (isTransientNetworkError(cause) || cause instanceof IncompleteModelStreamError)) {
        throw filterRetryableModelError(
          new APICallError({
            message: cause instanceof Error ? cause.message : String(cause),
            url: "",
            requestBodyValues: {},
            cause,
            isRetryable: true,
          }),
        );
      }
      throw filterRetryableModelError(cause);
    }
  },
};

export type AgentModelRequestGuardResult =
  | readonly ModelMessage[]
  | {
      readonly messages: readonly ModelMessage[];
      /** Optional per-step tool allow-list, applied by the AI SDK prepareStep boundary. */
      readonly activeTools?: readonly string[];
    };

export type AgentModelRequestGuard = (context: AgentModelRequestContext) => Promise<AgentModelRequestGuardResult | void>;

export interface AgentSendOptions {
  ifBusy?: "defer" | "join" | "reject";
  /** Other inputs admitted with this batch as context, without making them current requests. */
  contextMessages?: readonly AgentMessage[];
  /** Event-triggered turns must not reuse an earlier conversation request as current work. */
  historyMode?: AgentHistoryMode;
}

export interface AgentAppendOptions {
  /** Persist an input for a later send/run without exposing it to other turns. */
  deferred?: boolean;
}

export interface AgentTurnStream extends AsyncIterable<AgentInternalEvent> {
  readonly turnId: string;
}

export interface AgentModelRequestContext {
  readonly model: LanguageModel;
  readonly system: string | SystemModelMessage | readonly SystemModelMessage[] | undefined;
  readonly messages: readonly ModelMessage[];
  readonly tools: ToolSet;
  readonly toolChoice?: "required";
  readonly currentMessageIds: readonly string[];
  readonly projection?: AgentRequestProjection;
  readonly historyMode?: AgentHistoryMode;
  readonly turnId: string;
  readonly stepNumber: number;
  readonly signal: AbortSignal;
  readonly rebuildMessages: () => Promise<readonly ModelMessage[]>;
}

export interface AgentConfig {
  id?: string;
  model: LanguageModel;
  systemPrompt?: SystemPromptAppend | ((runtime: AgentPluginRuntime) => Promise<SystemPromptAppend | void> | SystemPromptAppend | void);
  tools?: AgentToolSet;
  providerTools?: ToolSet;
  storage?: AgentStorage<AgentEntry>;
  /** Durable per-call admission/results, scoped by the caller to one session or task. */
  toolJournal?: ToolJournal;
  plugins?: AgentPlugin[];
  /** Host-owned final authorization, applied after extension filters and argument replacements. */
  toolBoundary?: Pick<AgentPlugin, "filterTools" | "beforeToolCall">;
  /** Tool steps one model request may take (default 60). */
  maxSteps?: number;
  /** Called when a request used all `maxSteps` steps and was cut off mid-work. */
  onStepLimit?: (context: { turnId: string; steps: number }) => void;
  /**
   * Non-terminal tools (e.g. `send_message`) the repair request after the step limit may also use,
   * so the model can tell the user what was done and what is left before its terminal call. Only
   * applies with `requireTerminalTool`; without it the repair offers terminal tools only.
   */
  stepLimitReportTools?: readonly string[];
  maxRetries?: number;
  /** Correlation metadata only; never included in provider input or headers. */
  modelRequestContext?: { readonly sessionId?: string; readonly taskId?: string };
  /**
   * Provider request hint forwarded to `streamText()`. Callers must gate this on a resolved model
   * capability; the runtime never infers it from the provider name. `"required"` only means the
   * model must call some available tool, so it does not replace the terminal-tool invariant.
   */
  toolChoice?: "required";
  /**
   * Runs after per-step plugin preparation and before the provider request. Returning messages
   * replaces the request for this step; throwing prevents the provider request.
   */
  beforeModelRequest?: AgentModelRequestGuard;
  /** Public action summary, awaited before a local tool call reaches execution. */
  beforeToolPreamble?: (context: { turnId: string; text: string; toolName: string }) => Promise<void>;
  /** Synchronous main-model observation before the next request; stepNumber is turn-global. */
  onModelUsage?: (context: { turnId: string; stepNumber: number; inputTokens: number | undefined }) => void;
  /** Optional request-only provenance for guards; no metadata is added to provider messages. */
  requestProjection?: AgentRequestProjection;
  /** Optional output cap. Absent preserves the provider's existing default. */
  maxOutputTokens?: number | ((model: LanguageModel) => number);
  /**
   * Rejects a turn that never produced a terminal tool call instead of settling it as successful.
   * If an intermediate tool already ran, the runtime allows one request-only terminal repair before
   * failing. Defaults to `false` so existing callers keep their current turn semantics.
   */
  requireTerminalTool?: boolean;
  initialState?: AgentState;
  defaultState?: AgentState;
}

export interface Agent {
  readonly id: string;
  readonly channel: AgentChannel;
  readonly storage: AgentStorage<AgentEntry>;
  readonly state: AgentStateManager;
  init(): Promise<void>;
  /**
   * The system prompt and tools as frozen at initialization (initializing first): the configured base blocks,
   * then each plugin's appended blocks with its name. Read-only; for showing what the model receives.
   */
  promptSnapshot(): Promise<AgentPromptSnapshot>;
  stop(): Promise<void>;
  append(message: AgentMessage, options?: AgentAppendOptions): Promise<void>;
  /** Release a persisted deferred input as an observation without triggering a turn. */
  observe(message: AgentMessage): void;
  send(message: AgentMessage, options?: AgentSendOptions): string;
  run(message: AgentMessage, options?: AgentSendOptions): AgentTurnStream;
  /** Replace an exact queued turn's current input; retain its previous inputs as deferred context. */
  replaceQueued(turnId: string, message: AgentMessage, options?: Pick<AgentSendOptions, "contextMessages">): boolean;
  wait(options?: AgentWaitOptions): Promise<void>;
  interrupt(reason?: unknown): Promise<void>;
  getModel(): LanguageModel;
  setModel(model: LanguageModel): void;
  clear(): Promise<void>;
  getActiveTurnId(): string | null;
  isIdle(): boolean;
}

export interface AgentPromptSnapshot {
  readonly base: readonly SystemModelMessage[];
  readonly plugins: readonly SystemPromptSource[];
  readonly tools: readonly { readonly name: string; readonly description?: string }[];
}

export function createAgent(config: AgentConfig): Agent {
  const id = config.id ?? crypto.randomUUID();
  const baseStorage = config.storage ?? createMemoryStorage();
  const channel = createAgentChannel();

  let storageReady = Promise.resolve();
  const mutateStorage = async <T>(operation: () => Promise<T>): Promise<T> => {
    const next = storageReady.then(operation, operation);
    storageReady = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const storage: AgentStorage<AgentEntry> = {
    append: (...entries) => mutateStorage(() => Promise.resolve(baseStorage.append(...entries))),
    read: () => storageReady.then(() => baseStorage.read()),
    clear: () => mutateStorage(() => Promise.resolve(baseStorage.clear())),
  };
  const state = createStateManager({ storage, initialState: config.initialState ?? config.defaultState });

  let model = config.model;
  const baseTools = config.tools ?? [];
  const maxSteps = Math.max(1, config.maxSteps ?? DEFAULT_MAX_STEPS);
  const maxRetries = normalizeMaxRetries(config.maxRetries);
  let frozenSystemPrompt: SystemModelMessage[] | undefined;
  let frozenTools: AgentToolSet = [];
  let frozenBase: SystemModelMessage[] = [];
  let frozenProviderTools: ToolSet = {};

  const pluginHost = createPluginHost({
    plugins: config.plugins ?? [],
    runtime: { id, channel, state, storage, getModel: () => model, setModel: (next) => (model = next) },
  });

  const runtimeContext = { runtime: { id }, channel, state, storage, getModel: () => model, setModel: (next: LanguageModel) => (model = next) };

  let initialized = false;
  let initPromise: Promise<void> | undefined;
  const turnStreams = new Map<string, Set<(event: AgentInternalEvent) => void>>();
  const turnEventBuffer = new Map<string, AgentInternalEvent[]>();
  let appendPipelineReady = Promise.resolve();
  let activeTurnEntryCollector: ((entries: readonly AgentEntry[]) => void) | undefined;
  const submittedMessageEntries = new WeakMap<object, Array<Extract<AgentEntry, { type: "message" }>>>();
  const deferredEntryIds = new Set<string>();
  const submittedContexts = new WeakMap<object, readonly AgentMessage[]>();

  const runAppendPipeline = async <T>(operation: () => Promise<T>): Promise<T> => {
    const next = appendPipelineReady.then(operation, operation);
    appendPipelineReady = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const emitInternal = <T extends AgentInternalEventInit>(event: T): AgentInternalEvent<T> => {
    const created = createInternalEvent(event);

    if (isTurnScopedEvent(created)) {
      const buffered = turnEventBuffer.get(created.turnId) ?? [];
      buffered.push(created);
      turnEventBuffer.set(created.turnId, buffered);

      for (const listener of turnStreams.get(created.turnId) ?? []) {
        listener(created);
      }
    }

    void Promise.resolve(channel.emit("internal", created)).catch(() => undefined);

    return created;
  };

  const appendEntries = async (entries: AgentEntry[], options: { turnId?: string; deferred?: boolean } = {}): Promise<AgentEntry[]> => {
    if (entries.length === 0) {
      return [];
    }

    return runAppendPipeline(async () => {
      const transformed = await pluginHost.helpers.onAppend(entries, runtimeContext);
      const persisted = sanitizeAgentEntriesForPersistence(transformed);
      await storage.append(...persisted);
      if (options.deferred) {
        for (const entry of transformed) {
          if (entry.type === "message") deferredEntryIds.add(entry.id);
        }
      } else activeTurnEntryCollector?.(transformed);

      for (const entry of transformed) {
        if (entry.type !== "message") continue;

        await emitInternal(
          options.turnId ? { type: "message.appended", message: entry.data, turnId: options.turnId } : { type: "message.appended", message: entry.data },
        );
      }

      return transformed;
    });
  };

  const persistTerminalTurnEvent = async (event: AgentInternalEventInit & { turnId: string }) => {
    const created = await emitInternal(event);
    await storage.append(createEventEntry(created));
  };

  const ensureInit = () => {
    if (initialized) {
      return Promise.resolve();
    }
    if (initPromise) {
      return initPromise;
    }

    initPromise = (async () => {
      const base = await resolveConfiguredSystemPrompt(config.systemPrompt, {
        id,
        channel,
        state,
        storage,
        getModel: () => model,
        setModel: (next) => (model = next),
      });

      await pluginHost.init({ baseTools });

      frozenBase = [...base];
      const blocks = [...base, ...pluginHost.stablePromptBlocks];
      frozenSystemPrompt = blocks.length > 0 ? blocks : undefined;
      frozenTools = [...pluginHost.stableTools];
      frozenProviderTools = {};
      const toolNames = new Set(frozenTools.map((tool) => tool.name));
      for (const [name, tool] of Object.entries(config.providerTools ?? {})) {
        if (toolNames.has(name)) throw new ToolConflictError(name);
        frozenProviderTools[name] = { ...tool };
      }
      initialized = true;
      await emitInternal({ type: "agent.init" });
    })().finally(() => {
      if (!initialized) {
        initPromise = undefined;
      }
    });

    return initPromise;
  };

  const resolveTools = (
    turnId: string,
    currentMessages: () => readonly AgentMessage[],
    deferredCalls: Set<string>,
    acceptedTerminalCalls: Map<string, string>,
    currentTools: () => ReadonlyMap<string, AgentTool>,
    signal?: AbortSignal,
    selectedTools: AgentToolSet = frozenTools,
  ): AgentToolSet => {
    const merged = selectedTools;

    let serial = Promise.resolve();
    const delegated = new WeakMap<object, readonly string[]>();
    let delegatedCall = 0;
    const wrapped: AgentToolSet = [];

    for (const tool of merged) {
      const toolName = tool.name;
      const execute = tool.execute;
      const wrappedTool: AgentTool = {
        ...tool,
        ...(config.toolJournal && typeof execute === "function"
          ? {
              toModelOutput: async (context: Parameters<NonNullable<AgentTool["toModelOutput"]>>[0]) => {
                if (context.output instanceof ToolJournalNotice)
                  return {
                    type: "error-json" as const,
                    value: {
                      code: context.output.code,
                      executionStatus: context.output.executionStatus,
                      automaticReplayBlocked: true,
                      message: context.output.message,
                    },
                  };
                return tool.toModelOutput
                  ? await tool.toModelOutput(context)
                  : typeof context.output === "string"
                    ? { type: "text" as const, value: context.output }
                    : { type: "json" as const, value: context.output === undefined ? null : context.output };
              },
            }
          : {}),
        execute: execute
          ? async (input, options) => {
              const performCall = async () => {
                // A reused identity must not inherit acceptance from an earlier attempt.
                acceptedTerminalCalls.delete(options.toolCallId);
                deferredCalls.delete(options.toolCallId);
                const hookContext: ToolHookContext = {
                  ...runtimeContext,
                  turnId,
                  signal: options.abortSignal ?? signal,
                  messages: [...currentMessages()],
                };
                throwIfAborted(hookContext.signal);

                const originalCall = { toolCallId: options.toolCallId, toolName, args: input };
                let decision = await pluginHost.helpers.beforeToolCall({ type: "allow" }, originalCall, hookContext);
                const nextArgs = decision.type === "replace" ? decision.args : input;
                if (decision.type !== "block") {
                  // A filter controls actual execution too, even if a model emits an unavailable name.
                  const selected = currentTools().get(toolName);
                  if (!selected) decision = { type: "block", reason: "tool_unavailable", retry: false };
                  else {
                    const final = await config.toolBoundary?.beforeToolCall?.({ ...originalCall, args: nextArgs }, hookContext);
                    if (final?.type === "block") decision = final;
                    else if (final?.type === "replace") decision = final;
                  }
                }
                throwIfAborted(hookContext.signal);

                const nextInput = decision.type === "replace" ? decision.args : input;

                if (decision.type === "block") {
                  if (decision.retry) deferredCalls.add(options.toolCallId);
                  await emitInternal({ type: "tool.blocked", turnId, toolName, toolCallId: options.toolCallId, reason: decision.reason });
                  return { blocked: true, reason: decision.reason };
                }

                const perform = async () => {
                  await emitInternal({ type: "tool.start", turnId, toolName, toolCallId: options.toolCallId, args: nextInput });
                  let afterStarted = false;
                  try {
                    const executeContext: AgentToolExecuteContext = {
                      ...options,
                      runtime: { id },
                      channel,
                      state,
                      storage,
                      turnId,
                      abortSignal: hookContext.signal,
                      messages: [...currentMessages()],
                      invokeTool: async (name, args) => {
                        const path = delegated.get(options) ?? [toolName];
                        if (path.length >= 8 || path.includes(name)) throw new Error("tool_delegation_cycle");
                        const target = currentTools().get(name);
                        if (!target || typeof target.execute !== "function" || target.terminal || target.capability?.executionKind === "communication")
                          throw new Error("tool_delegate_denied");
                        const checked = await validateInvokedInput(target, args);
                        const nested = { ...options, toolCallId: `${options.toolCallId}.delegate.${++delegatedCall}`, abortSignal: hookContext.signal };
                        delegated.set(nested, [...path, name]);
                        return target.execute(checked, nested as AgentToolExecuteContext);
                      },
                    };
                    const output = await raceAbort(Promise.resolve(execute(nextInput, executeContext)), hookContext.signal);
                    throwIfAborted(hookContext.signal);
                    afterStarted = true;
                    const result = await pluginHost.helpers.afterToolCall(
                      { toolCallId: options.toolCallId, toolName, args: nextInput, result: output, isError: false },
                      hookContext,
                    );
                    return result.result;
                  } catch (error) {
                    const diagnostic = createDiagnostic(error);
                    // A failing result hook may already have effects. Never invoke that hook twice.
                    if (!afterStarted)
                      await pluginHost.helpers.afterToolCall(
                        { toolCallId: options.toolCallId, toolName, args: nextInput, result: diagnostic, isError: true },
                        hookContext,
                      );
                    await emitInternal({ type: "tool.failed", turnId, toolName, toolCallId: options.toolCallId, error: diagnostic, args: nextInput });
                    throw error;
                  }
                };
                const result = config.toolJournal
                  ? await config.toolJournal.execute({ turnId, toolCallId: options.toolCallId, toolName, input: nextInput }, perform, {
                      signal: hookContext.signal,
                      replayable: !tool.toModelOutput,
                    })
                  : await perform();
                if (result instanceof ToolJournalNotice) {
                  await emitInternal({
                    type: "tool.blocked",
                    turnId,
                    toolName,
                    toolCallId: options.toolCallId,
                    reason: result.message,
                    journalCode: result.code,
                    executionStatus: result.executionStatus,
                    automaticReplayBlocked: true,
                  });
                } else {
                  await emitInternal({ type: "tool.done", turnId, toolName, toolCallId: options.toolCallId, result });
                  try {
                    if (tool.terminal === true || (typeof tool.terminal === "function" && tool.terminal(nextInput, result)))
                      acceptedTerminalCalls.set(options.toolCallId, toolName);
                  } catch {
                    // A failing acceptance predicate cannot establish a terminal result, and must
                    // not turn an already completed effect into a retryable execution failure.
                  }
                }
                return result;
              };
              // A delegate executes inside its parent's serial slot; queueing it would deadlock.
              if (delegated.has(options)) return performCall();
              const run = serial.then(performCall);
              serial = run.then(
                () => undefined,
                () => undefined,
              );
              return run;
            }
          : undefined,
      } as AgentTool;
      wrapped.push(wrappedTool);
    }

    return wrapped;
  };

  const collectPersistedEntries = async (): Promise<readonly AgentEntry[]> => {
    await appendPipelineReady;
    const rawEntries = await storage.read();
    return sanitizeAgentEntriesForPersistence(rawEntries);
  };

  const rememberSubmittedEntries = (messages: AgentMessage[], entries: Array<Extract<AgentEntry, { type: "message" }>>) => {
    if (messages.length !== entries.length) {
      return;
    }

    for (const [index, message] of messages.entries()) {
      submittedMessageEntries.set(message, [entries[index]]);
    }
  };

  const persistCurrentMessages = async (messages: AgentMessage[], turnId: string) => {
    const knownEntries: Array<Extract<AgentEntry, { type: "message" }>> = [];
    const freshMessages: AgentMessage[] = [];

    for (const message of messages) {
      const entries = submittedMessageEntries.get(message);
      if (entries) {
        knownEntries.push(...entries);
      } else {
        freshMessages.push(message);
      }
    }

    if (freshMessages.length > 0) {
      const transformed = await appendEntries(
        freshMessages.map((message) => createMessageEntry(message)),
        { turnId },
      );
      const freshEntries = transformed.filter((entry): entry is Extract<AgentEntry, { type: "message" }> => entry.type === "message");
      rememberSubmittedEntries(freshMessages, freshEntries);
      knownEntries.push(...freshEntries);
    }
    // Only the owning turn (or an explicit busy join) admits reserved inputs. Persistence by
    // itself must not let an earlier turn answer a queued input before its own turn starts.
    for (const entry of knownEntries) deferredEntryIds.delete(entry.id);
    return knownEntries;
  };

  const buildBoundaryModelMessages = async (
    turnId: string,
    currentEntries: Array<Extract<AgentEntry, { type: "message" }>>,
    liveEntries: ReadonlyMap<string, Extract<AgentEntry, { type: "message" }>>,
    activeInputs: readonly AgentMessage[],
    signal: AbortSignal,
    historyMode: AgentHistoryMode,
  ) => {
    const persisted = (await collectPersistedEntries()).filter((entry) => entry.type !== "message" || !deferredEntryIds.has(entry.id));
    const visibleLiveEntries = new Map([...liveEntries].filter(([entryId]) => !deferredEntryIds.has(entryId)));
    currentEntries = currentEntries.filter((entry) => !deferredEntryIds.has(entry.id));
    const currentEntryIds = new Set(currentEntries.map((entry) => entry.id));
    // The persisted-history projection may only see messages that predate this turn; current-turn
    // entries keep their raw assistant/tool pairing and must not be dropped as delivered output.
    const historicalEntries = persisted.filter((entry) => entry.type !== "message" || !visibleLiveEntries.has(entry.id));
    const projection = config.requestProjection;
    if (projection) {
      for (const entry of historicalEntries) {
        if (entry.type === "message")
          projection.register(entry.data, {
            kind: entry.data.role === "system" ? "mandatory" : "history",
            sourceEntryIds: [entry.id],
            timestamp: entry.timestamp,
          });
      }
      for (const entry of visibleLiveEntries.values())
        projection.register(entry.data, {
          kind: "live",
          sourceEntryIds: [entry.id],
          timestamp: entry.timestamp,
        });
    }
    const projectedHistory =
      historyMode === "event" ? [] : await pluginHost.helpers.transformEntries(historicalEntries, { runtime: { id }, channel, state, turnId, signal });

    // A projection may deliberately reorder persisted history (for example, moving a region
    // summary before the retained tail). Keep that projected order intact, then append raw entries
    // captured by this turn's append pipeline. Map insertion order follows durable append order,
    // while id lookup keeps an entry stable and deduplicated across repeated boundary rebuilds.
    const liveHistoryEntries = [...visibleLiveEntries.values()].filter((entry) => !currentEntryIds.has(entry.id));
    const history = [...projectedHistory, ...liveHistoryEntries]
      .filter((entry): entry is Extract<AgentEntry, { type: "message" }> => entry.type === "message")
      .map((entry) => entry.data);
    const current = currentEntries.map((entry) => entry.data);
    const live = [...visibleLiveEntries.values()].map((entry) => entry.data);

    return buildModelMessages({
      history,
      current,
      activeInputs,
      live,
      pluginHost,
      context: { runtime: { id }, channel, state, turnId, signal, ...(projection ? { projection } : {}) },
    });
  };

  const createTurnStream = (turnId: string): AgentTurnStream => {
    const queue = [...(turnEventBuffer.get(turnId) ?? [])];
    let done = queue.some(isTerminalTurnEvent);
    let resume: (() => void) | undefined;

    const cleanup = (listener: (event: AgentInternalEvent) => void) => {
      const listeners = turnStreams.get(turnId);
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        turnStreams.delete(turnId);
      }
      turnEventBuffer.delete(turnId);
    };

    const push = (event: AgentInternalEvent) => {
      queue.push(event);
      if (isTerminalTurnEvent(event)) {
        done = true;
      }
      const notify = resume;
      resume = undefined;
      notify?.();
    };

    const listeners = turnStreams.get(turnId) ?? new Set<typeof push>();
    listeners.add(push);
    turnStreams.set(turnId, listeners);

    return {
      turnId,
      [Symbol.asyncIterator]() {
        return {
          async next() {
            while (queue.length === 0) {
              if (done) {
                cleanup(push);
                return { done: true, value: undefined };
              }
              await new Promise<void>((resolve) => {
                resume = resolve;
              });
            }

            const value = queue.shift()!;
            if (done && queue.length === 0 && isTerminalTurnEvent(value)) {
              cleanup(push);
            }
            return { done: false, value };
          },
        };
      },
    };
  };

  const executeTurn = async (request: TurnRequest): Promise<TurnResult> => {
    const allMessages: AgentMessage[] = [];
    const liveTurnEntries = new Map<string, Extract<AgentEntry, { type: "message" }>>();
    let activeInputs: readonly AgentMessage[] = [];
    const rememberLiveEntries = (entries: readonly AgentEntry[]) => {
      for (const entry of entries) {
        if (entry.type === "message") liveTurnEntries.set(entry.id, entry);
      }
    };
    const admitBatch = async (messages: AgentMessage[]) => {
      const contextMessages = messages.flatMap((message) => submittedContexts.get(message) ?? []);
      const contextEntries = await persistCurrentMessages(contextMessages, request.turnId);
      rememberLiveEntries(contextEntries);
      allMessages.push(...contextEntries.map((entry) => entry.data));
      return persistCurrentMessages(messages, request.turnId);
    };
    // Event turns admit only their explicit current/joined inputs and step outputs below.
    // Unscoped appends may belong to a deferred conversation turn, not this isolated event.
    activeTurnEntryCollector = request.historyMode === "event" ? undefined : rememberLiveEntries;
    let turnUsage: Partial<LanguageModelUsage> | undefined;
    let latestStepUsage: Partial<LanguageModelUsage> | undefined;
    let currentBatch = request.messages.splice(0, request.messages.length);
    const abortSignal = request.signal;
    // Resolved after `ensureInit()`: plugin-provided tools only exist once the plugin host is frozen.
    let isTerminalToolCall: (call: { toolName: string; input?: unknown; invalid?: boolean }) => boolean = () => false;
    // Terminal tools are tracked across every step of the turn: a step that only ran intermediate
    // tools keeps the loop going, and a terminal call in any step settles the invariant.
    const deferredCalls = new Set<string>();
    const acceptedTerminalCalls = new Map<string, string>();
    let sawTerminalToolCall = false;
    let sawIntermediateToolCall = false;
    let sawNonEmptyText = false;
    let runTerminalRecovery = false;
    let terminalRecoveryAttempted = false;
    /** The pending repair follows a step-limit cut-off, so it may also report progress. */
    let stepLimitRecovery = false;
    let nextTurnStepNumber = 0;

    try {
      await ensureInit();
      isTerminalToolCall = createTerminalToolCallMatcher(frozenTools, acceptedTerminalCalls);
      const terminalToolNames = new Set(frozenTools.filter((tool) => tool.terminal === true || typeof tool.terminal === "function").map((tool) => tool.name));
      const reportTools = (config.stepLimitReportTools ?? []).filter((name) => !terminalToolNames.has(name) && frozenTools.some((tool) => tool.name === name));
      await emitInternal({ type: "turn.start", turnId: request.turnId });

      while (currentBatch.length > 0 || runTerminalRecovery) {
        const isTerminalRecovery = runTerminalRecovery;
        runTerminalRecovery = false;
        // After the step limit the model may first say where it got to, then end the turn.
        const reportingRecovery = isTerminalRecovery && stepLimitRecovery && reportTools.length > 0;
        stepLimitRecovery = false;
        const recoveryPrompt = reportingRecovery ? stepLimitRecoveryPrompt(maxSteps, reportTools) : TERMINAL_TOOL_RECOVERY_PROMPT;
        const recoveryToolNames = reportingRecovery ? new Set([...terminalToolNames, ...reportTools]) : terminalToolNames;
        let requestSteps = 0;
        let lastStepUnfinished = false;

        const currentEntries = isTerminalRecovery ? [] : await admitBatch(currentBatch);
        if (currentEntries.length) activeInputs = currentEntries.map((entry) => entry.data);
        rememberLiveEntries(currentEntries);
        allMessages.push(...currentEntries.map((entry) => entry.data));

        const baseModelMessages = await buildBoundaryModelMessages(
          request.turnId,
          currentEntries,
          liveTurnEntries,
          activeInputs,
          abortSignal,
          request.historyMode,
        );
        const recoveryMessage: ModelMessage | undefined = isTerminalRecovery ? { role: "user", content: recoveryPrompt } : undefined;
        const prepareRequestMessages = (messages: readonly ModelMessage[]): ModelMessage[] => {
          if (!recoveryMessage) return [...messages];
          return [...messages.filter((message) => !(message.role === "user" && message.content === recoveryPrompt)), recoveryMessage];
        };
        const modelMessages = prepareRequestMessages(baseModelMessages);

        let aborted = false;
        let persistedResponseMessageCount = 0;
        const retry = prepareRetryModel(model, maxRetries);
        let currentToolCatalog = new Map<string, AgentTool>();
        const resolvedAgentTools = frozenTools;
        const resolvedTools = toAiToolSet(resolvedAgentTools);
        const effectiveTools: ToolSet = isTerminalRecovery
          ? Object.fromEntries(Object.entries(resolvedTools).filter(([name]) => recoveryToolNames.has(name)))
          : { ...resolvedTools, ...frozenProviderTools };
        const requestToolChoice = isTerminalRecovery ? "required" : config.toolChoice;
        const outputCap = () => (typeof config.maxOutputTokens === "function" ? config.maxOutputTokens(retry.model) : config.maxOutputTokens);
        const requestModel =
          config.beforeToolPreamble && isLanguageModelV3(retry.model)
            ? wrapLanguageModel({
                model: retry.model,
                middleware: toolPreambleMiddleware((text, toolName) => config.beforeToolPreamble!({ turnId: request.turnId, text, toolName })),
              })
            : retry.model;
        const contextualModel = () =>
          isLanguageModelV3(requestModel)
            ? wrapLanguageModel({
                model: requestModel,
                middleware: modelRequestContextMiddleware({
                  ...config.modelRequestContext,
                  agentId: id,
                  turnId: request.turnId,
                  retryBudget: { remaining: maxRetries },
                }),
              })
            : requestModel;
        const response = streamText({
          model: contextualModel(),
          system: frozenSystemPrompt,
          messages: modelMessages,
          tools: effectiveTools,
          ...(config.maxOutputTokens === undefined ? {} : { maxOutputTokens: outputCap() }),
          ...(requestToolChoice ? { toolChoice: requestToolChoice } : {}),
          stopWhen: reportingRecovery
            ? [
                // Report, then end: stop at the first terminal call, bounded either way.
                ({ steps }) => !!steps.at(-1)?.toolCalls.some((call) => isTerminalToolCall(call)),
                stepCountIs(STEP_LIMIT_RECOVERY_STEPS),
              ]
            : isTerminalRecovery
              ? [
                  // A deferred or rejected terminal call still needs a model review before
                  // recovery may stop; only its accepted result can settle the turn.
                  ({ steps }) => {
                    const last = steps.at(-1);
                    return (
                      !!last &&
                      !last.toolCalls.some((call) => deferredCalls.has(call.toolCallId) || (terminalToolNames.has(call.toolName) && !isTerminalToolCall(call)))
                    );
                  },
                  stepCountIs(maxSteps),
                  allToolCallsTerminal(frozenTools, acceptedTerminalCalls),
                ]
              : [isLoopFinished(), stepCountIs(maxSteps), allToolCallsTerminal(frozenTools, acceptedTerminalCalls)],
          abortSignal,
          prepareStep: async ({ stepNumber }) => {
            throwIfAborted(abortSignal);
            let messages = modelMessages;
            if (stepNumber > 0) {
              const joined = await request.drainJoined();
              if (joined.length === 0) {
                messages = await buildBoundaryModelMessages(request.turnId, [], liveTurnEntries, activeInputs, abortSignal, request.historyMode);
              } else {
                const joinedEntries = await admitBatch(joined);
                if (joinedEntries.length) activeInputs = joinedEntries.map((entry) => entry.data);
                rememberLiveEntries(joinedEntries);
                allMessages.push(...joinedEntries.map((entry) => entry.data));
                messages = await buildBoundaryModelMessages(request.turnId, joinedEntries, liveTurnEntries, activeInputs, abortSignal, request.historyMode);
              }
            }

            const prepareContext = {
              messages: [...allMessages],
              ...(config.requestProjection ? { projection: config.requestProjection } : {}),
              runtime: { id },
              channel,
              state,
              turnId: request.turnId,
              stepNumber,
              signal: abortSignal,
            };
            const prepared = prepareRequestMessages(await pluginHost.helpers.prepareStep(messages, prepareContext));
            const filterContext = {
              ...runtimeContext,
              turnId: request.turnId,
              stepNumber,
              signal: abortSignal,
              messages: [...allMessages],
            };
            const candidates: AgentToolSet = [
              ...resolvedAgentTools,
              ...Object.entries(frozenProviderTools).map(([name, tool]) => ({ ...tool, name }) as unknown as AgentTool),
            ];
            let filteredAgentTools = await pluginHost.helpers.filterTools(candidates, {
              ...runtimeContext,
              turnId: request.turnId,
              stepNumber,
              signal: abortSignal,
              messages: [...allMessages],
            });
            filteredAgentTools = (await config.toolBoundary?.filterTools?.(filteredAgentTools, filterContext)) ?? filteredAgentTools;
            if (isTerminalRecovery) filteredAgentTools = filteredAgentTools.filter((tool) => recoveryToolNames.has(tool.name));
            const executableTools = resolveTools(
              request.turnId,
              () => allMessages,
              deferredCalls,
              acceptedTerminalCalls,
              () => currentToolCatalog,
              abortSignal,
              filteredAgentTools,
            );
            currentToolCatalog = new Map(executableTools.map((tool) => [tool.name, tool]));
            const filteredTools = toAiToolSet(executableTools);
            // The SDK keeps this ToolSet object for schema preparation and execution. Update it in
            // place so a read-only projection's schema AND execute closure are the real ones.
            for (const name of Object.keys(effectiveTools)) delete effectiveTools[name];
            Object.assign(effectiveTools, filteredTools);
            const activeToolNames = Object.keys(filteredTools);
            const guard = config.beforeModelRequest;
            // One budget per model step, shared by SDK retries and explicit transport compatibility.
            const stepModel = contextualModel();
            if (!guard) {
              throwIfAborted(abortSignal);
              return {
                model: stepModel,
                messages: prepared,
                activeTools: activeToolNames,
                ...(requestToolChoice ? { toolChoice: requestToolChoice } : {}),
                ...(config.maxOutputTokens === undefined ? {} : { maxOutputTokens: outputCap() }),
              };
            }

            const guarded = await guard({
              model: retry.model,
              system: frozenSystemPrompt,
              messages: prepared,
              tools: filteredTools,
              ...(requestToolChoice ? { toolChoice: requestToolChoice } : {}),
              currentMessageIds: [...liveTurnEntries.keys()].filter((entryId) => !deferredEntryIds.has(entryId)),
              ...(config.requestProjection ? { projection: config.requestProjection, historyMode: request.historyMode } : {}),
              turnId: request.turnId,
              stepNumber: nextTurnStepNumber,
              signal: abortSignal,
              rebuildMessages: async () => {
                const rebuilt = await buildBoundaryModelMessages(
                  request.turnId,
                  [...liveTurnEntries.values()],
                  liveTurnEntries,
                  activeInputs,
                  abortSignal,
                  request.historyMode,
                );
                const rebuiltPrepared = await pluginHost.helpers.prepareStep(prepareRequestMessages(rebuilt), prepareContext);
                return prepareRequestMessages(rebuiltPrepared);
              },
            });
            throwIfAborted(abortSignal);
            const guardedObject = !Array.isArray(guarded) && guarded ? (guarded as Exclude<AgentModelRequestGuardResult, readonly ModelMessage[]>) : undefined;
            const guardedMessages = guardedObject?.messages ?? (Array.isArray(guarded) ? guarded : prepared);
            const guardedActiveTools = guardedObject?.activeTools;
            const activeTools = guardedActiveTools === undefined ? activeToolNames : activeToolNames.filter((name) => guardedActiveTools.includes(name));
            for (const name of [...currentToolCatalog.keys()]) if (!activeTools.includes(name)) currentToolCatalog.delete(name);
            return {
              model: stepModel,
              messages: prepareRequestMessages(guardedMessages),
              activeTools,
              ...(requestToolChoice ? { toolChoice: requestToolChoice } : {}),
              ...(config.maxOutputTokens === undefined ? {} : { maxOutputTokens: outputCap() }),
            };
          },
          maxRetries: retry.maxRetries,
          // The SDK default logs raw provider errors/request bodies. turn.failed exposes the
          // sanitized diagnostic below; a second raw log would leak request content.
          onError() {},
          onAbort() {
            aborted = true;
          },
          onStepFinish: async (step) => {
            const responseMessages = step.response.messages.slice(persistedResponseMessageCount);
            persistedResponseMessageCount = step.response.messages.length;
            const stepMessages: AgentMessage[] = responseMessages.map((message) =>
              message.role === "assistant"
                ? createAssistantMessage(message.content, { providerOptions: message.providerOptions, usage: step.usage, finishReason: step.finishReason })
                : createToolMessage(message.content),
            );
            turnUsage = mergeUsage(turnUsage, step.usage);
            latestStepUsage = step.usage;
            config.onModelUsage?.({ turnId: request.turnId, stepNumber: nextTurnStepNumber, inputTokens: step.usage.inputTokens });
            requestSteps++;
            const calls = step.toolCalls ?? [];
            lastStepUnfinished = calls.length > 0 && !calls.every((call) => isTerminalToolCall(call));

            for (const call of calls) {
              if (isTerminalToolCall(call)) {
                sawTerminalToolCall = true;
                continue;
              }
              // A malformed call bought the turn nothing: it is neither a terminal action nor a
              // completed intermediate action.
              if (call.invalid) continue;
              sawIntermediateToolCall = true;
            }
            if (typeof step.text === "string" && step.text.trim().length > 0) {
              sawNonEmptyText = true;
            }

            if (stepMessages.length > 0) {
              const stepEntries = await appendEntries(
                stepMessages.map((message) => createMessageEntry(message)),
                { turnId: request.turnId },
              );
              const liveStepEntries = stepEntries.filter((entry): entry is Extract<AgentEntry, { type: "message" }> => entry.type === "message");
              rememberLiveEntries(liveStepEntries);
              allMessages.push(...liveStepEntries.map((entry) => entry.data));
            }

            await emitInternal({
              type: "turn.step",
              turnId: request.turnId,
              step: nextTurnStepNumber++,
              usage: step.usage,
              finishReason: step.finishReason,
              reasoningText: step.reasoningText,
            });
          },
        });

        for await (const part of response.fullStream) {
          await channel.emit("stream", part.type === "error" ? { ...part, error: createDiagnostic(part.error) } : part);

          if (part.type === "text-delta") {
            const textPart = part as { text?: unknown; delta?: unknown };
            const delta = String(textPart.text ?? textPart.delta ?? "");
            await emitInternal({ type: "turn.delta", turnId: request.turnId, delta });
            continue;
          }
          if (part.type === "error") {
            throw part.error;
          }
        }

        if (aborted || abortSignal.aborted) {
          throw createAbortError();
        }

        currentBatch = await request.drainJoined();
        // The request ran out of steps while it still had work going.
        const hitStepLimit = !isTerminalRecovery && requestSteps >= maxSteps && lastStepUnfinished;
        if (hitStepLimit) config.onStepLimit?.({ turnId: request.turnId, steps: requestSteps });
        // A provider may stop after executing an intermediate tool without starting another model
        // step, or the step limit cut the work off. Give it one ephemeral terminal-only request,
        // without persisting a synthetic user message; a second miss still reaches the protocol
        // failure below. After the step limit, `stepLimitReportTools` may report progress first.
        if (
          !isTerminalRecovery &&
          !terminalRecoveryAttempted &&
          config.requireTerminalTool &&
          !sawTerminalToolCall &&
          sawIntermediateToolCall &&
          currentBatch.length === 0 &&
          terminalToolNames.size > 0
        ) {
          terminalRecoveryAttempted = true;
          runTerminalRecovery = true;
          stepLimitRecovery = hitStepLimit;
        }
      }

      if (config.requireTerminalTool && !sawTerminalToolCall) {
        throw new AgentProtocolError(resolveProtocolViolation({ sawNonEmptyText, sawIntermediateToolCall }));
      }

      await emitInternal({ type: "turn.done", turnId: request.turnId });
      const result: TurnResult = {
        turnId: request.turnId,
        status: "done",
        messages: allMessages,
        ...(turnUsage ? { usage: turnUsage } : {}),
        ...(latestStepUsage ? { latestStepUsage } : {}),
      };
      await pluginHost.helpers.onTurnFinish(result, { runtime: { id }, channel, state, turnId: request.turnId });
      return result;
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      const diagnostic = createDiagnostic(error);
      const result: TurnResult = { turnId: request.turnId, status: aborted ? "aborted" : "failed", messages: allMessages, error: diagnostic };
      await persistTerminalTurnEvent(
        aborted
          ? { type: "turn.aborted", turnId: request.turnId, reason: formatAbortReason(error, abortSignal) }
          : { type: "turn.failed", turnId: request.turnId, error: diagnostic },
      );
      await pluginHost.helpers.onTurnFinish(result, { runtime: { id }, channel, state, turnId: request.turnId });
      return result;
    } finally {
      if (activeTurnEntryCollector === rememberLiveEntries) activeTurnEntryCollector = undefined;
    }
  };

  const turnQueue = createTurnQueue({ onRun: executeTurn });

  const agent: Agent = {
    id,
    channel,
    storage,
    state,
    async init() {
      await ensureInit();
    },
    async promptSnapshot() {
      await ensureInit();
      return {
        base: [...frozenBase],
        plugins: pluginHost.stablePromptSources.map((source) => ({ plugin: source.plugin, blocks: [...source.blocks] })),
        tools: frozenTools.map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) })),
      };
    },
    async stop() {
      await initPromise?.catch(() => undefined);
      if (!initialized) return;

      await pluginHost.stop();
      initialized = false;
      initPromise = undefined;
      await emitInternal({ type: "agent.stop" });
    },
    async append(message, options = {}) {
      await this.init();
      const entries = await appendEntries([createMessageEntry(message)], options);
      const messageEntries = entries.filter((entry): entry is Extract<AgentEntry, { type: "message" }> => entry.type === "message");
      rememberSubmittedEntries([message], messageEntries);
    },
    observe(message) {
      const entries = submittedMessageEntries.get(message) ?? [];
      for (const entry of entries) deferredEntryIds.delete(entry.id);
      activeTurnEntryCollector?.(entries);
    },
    send(message, options = {}) {
      const activeTurnId = turnQueue.activeTurnId;
      let persistence: Promise<void> | undefined;

      if (options.contextMessages)
        submittedContexts.set(
          message,
          options.contextMessages.filter((context) => context !== message),
        );
      if (activeTurnId && (options.ifBusy ?? "defer") === "defer") {
        for (const input of [message, ...(submittedContexts.get(message) ?? [])]) {
          for (const entry of submittedMessageEntries.get(input) ?? []) deferredEntryIds.add(entry.id);
        }
      }

      if (options.ifBusy === "join" && activeTurnId && !submittedMessageEntries.has(message)) {
        persistence = appendEntries([createMessageEntry(message)], { turnId: activeTurnId }).then((entries) => {
          const messageEntries = entries.filter((entry): entry is Extract<AgentEntry, { type: "message" }> => entry.type === "message");
          rememberSubmittedEntries([message], messageEntries);
        });
      }

      const turnId = turnQueue.enqueue([message], options.ifBusy, persistence, options.historyMode);
      if (turnId !== activeTurnId) {
        void emitInternal({ type: "turn.queued", turnId });
      }
      return turnId;
    },
    run(message, options = {}) {
      const turnId = this.send(message, options);
      return createTurnStream(turnId);
    },
    replaceQueued(turnId, message, options = {}) {
      const previous = turnQueue.replaceQueued(turnId, [message]);
      if (!previous) return false;
      const contexts = [
        ...new Set([...previous.flatMap((input) => submittedContexts.get(input) ?? []), ...previous, ...(options.contextMessages ?? [])]),
      ].filter((input) => input !== message);
      submittedContexts.set(message, contexts);
      for (const input of [message, ...contexts]) {
        for (const entry of submittedMessageEntries.get(input) ?? []) deferredEntryIds.add(entry.id);
      }
      return true;
    },
    wait(options = {}) {
      return turnQueue.wait(options);
    },
    interrupt(reason) {
      return turnQueue.interrupt(reason);
    },
    getModel() {
      return model;
    },
    setModel(next) {
      model = next;
    },
    async clear() {
      await storage.clear();
      deferredEntryIds.clear();
    },
    getActiveTurnId() {
      return turnQueue.activeTurnId ?? null;
    },
    isIdle() {
      return turnQueue.isIdle();
    },
  };

  return agent;
}

async function validateInvokedInput(tool: AgentTool, input: unknown): Promise<unknown> {
  const parsed = await safeValidateTypes({ value: input, schema: tool.inputSchema });
  if (!parsed.success) throw new Error("tool_input_invalid");
  const schema = asSchema(tool.inputSchema);
  // jsonSchema() tools may have no validator. Delegation must still enforce their actual schema.
  if (!schema.validate) {
    const check = await compiledInputSchema(schema.jsonSchema);
    if (check && !check(parsed.value)) throw new Error("tool_input_invalid");
  }
  return parsed.value;
}

/**
 * Shared terminal-tool decision used by both the stop condition and the final protocol check, so a
 * tool can never end the loop without also satisfying the terminal invariant.
 */
function createTerminalToolCallMatcher(
  tools: AgentToolSet,
  acceptedTerminalCalls: ReadonlyMap<string, string>,
): (call: { toolCallId?: string; toolName: string; input?: unknown; invalid?: boolean }) => boolean {
  const terminalToolNames = new Set(tools.filter((tool) => tool.terminal === true || typeof tool.terminal === "function").map((tool) => tool.name));
  return (call) => !call.invalid && !!call.toolCallId && terminalToolNames.has(call.toolName) && acceptedTerminalCalls.get(call.toolCallId) === call.toolName;
}

/**
 * Stops the turn when every tool call in the final step has an accepted terminal result.
 * Admission, execution, and any per-tool acceptance predicate must all have succeeded.
 */
// eslint-disable-next-line typescript/no-explicit-any
function allToolCallsTerminal(tools: AgentToolSet, acceptedTerminalCalls: ReadonlyMap<string, string>): StopCondition<any> {
  const isTerminal = createTerminalToolCallMatcher(tools, acceptedTerminalCalls);
  const hasTerminalTools = tools.some((tool) => tool.terminal === true || typeof tool.terminal === "function");
  return ({ steps }: { steps: Array<{ toolCalls: Array<{ toolCallId: string; toolName: string; invalid?: boolean }> }> }) => {
    if (!hasTerminalTools) return false;
    const last = steps.at(-1);
    if (!last) return false;
    const calls = last.toolCalls;
    if (calls.length === 0) return false;
    return calls.every(isTerminal);
  };
}

/** The repair request after the step limit: report progress once, then end the turn. */
function stepLimitRecoveryPrompt(maxSteps: number, reportTools: readonly string[]): string {
  return `This turn has used all of its ${maxSteps} tool steps and must end now; do not start new work. First call ${reportTools.join(" or ")} once to briefly tell the user what was done and what is left, then call exactly one terminal tool (finish when available). Do not reply with assistant text; this is an internal repair step.`;
}

function resolveProtocolViolation(state: { sawNonEmptyText: boolean; sawIntermediateToolCall: boolean }): AgentProtocolViolation {
  if (state.sawNonEmptyText) return "text-only";
  if (state.sawIntermediateToolCall) return "non-terminal-tool";
  return "empty-or-no-terminal-tool";
}

function mergeUsage(current: Partial<LanguageModelUsage> | undefined, next: LanguageModelUsage | undefined): Partial<LanguageModelUsage> | undefined {
  if (!next) return current;
  return {
    ...current,
    inputTokens: (current?.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (current?.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens: (current?.totalTokens ?? 0) + (next.totalTokens ?? 0),
    ...(next.reasoningTokens !== undefined ? { reasoningTokens: (current?.reasoningTokens ?? 0) + next.reasoningTokens } : {}),
    ...(next.cachedInputTokens !== undefined ? { cachedInputTokens: (current?.cachedInputTokens ?? 0) + next.cachedInputTokens } : {}),
  };
}

function createAbortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function formatAbortReason(error: unknown, signal: AbortSignal): string {
  const errorCause = formatErrorCause(error);
  if (!signal.aborted || signal.reason === undefined) return errorCause;
  return `${errorCause} (signal: ${formatErrorCause(signal.reason)})`;
}

function normalizeMaxRetries(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(MAX_MODEL_RETRIES, Math.max(0, Math.trunc(value)));
}

function prepareRetryModel(model: LanguageModel, maxRetries: number): { readonly model: LanguageModel; readonly maxRetries: number } {
  if (!isLanguageModelV3(model)) return { model, maxRetries: 0 };
  return {
    model: wrapLanguageModel({
      model,
      middleware: maxRetries === 0 ? MODEL_REQUEST_ABORT_MIDDLEWARE : [TRANSIENT_MODEL_ERROR_MIDDLEWARE, MODEL_REQUEST_ABORT_MIDDLEWARE],
    }),
    maxRetries,
  };
}

function isLanguageModelV3(model: LanguageModel): model is Parameters<typeof wrapLanguageModel>[0]["model"] {
  return typeof model === "object" && model !== null && "specificationVersion" in model && model.specificationVersion === "v3";
}

function filterRetryableModelError(cause: unknown): unknown {
  if (!APICallError.isInstance(cause) || !cause.isRetryable) return cause;
  const status = cause.statusCode;
  const failure = classifyModelError(cause).kind;
  const transient =
    status === 408 ||
    (status === 429 && failure === "rate_limit") ||
    (status !== undefined && status >= 500 && status <= 599) ||
    (status === undefined && (isTransientNetworkError(cause.cause) || cause.cause instanceof IncompleteModelStreamError));
  if (transient && consumeModelRetry()) return cause;
  return new APICallError({
    message: cause.message,
    url: cause.url,
    requestBodyValues: cause.requestBodyValues,
    statusCode: cause.statusCode,
    responseHeaders: cause.responseHeaders,
    responseBody: cause.responseBody,
    cause: cause.cause,
    isRetryable: false,
    data: cause.data,
  });
}

function isTransientNetworkError(cause: unknown): boolean {
  let transient = false;
  for (let depth = 0; depth < 4 && cause instanceof Error; depth += 1) {
    if (cause.name === "AbortError" || cause.name === "ResponseAborted") return false;
    const code = (cause as Error & { code?: unknown }).code;
    if (
      cause.name === "TimeoutError" ||
      (typeof code === "string" &&
        [
          "ECONNRESET",
          "ECONNREFUSED",
          "EPIPE",
          "EAI_AGAIN",
          "ENETUNREACH",
          "EHOSTUNREACH",
          "ETIMEDOUT",
          "UND_ERR_CONNECT_TIMEOUT",
          "UND_ERR_HEADERS_TIMEOUT",
          "UND_ERR_BODY_TIMEOUT",
          "UND_ERR_SOCKET",
        ].includes(code))
    )
      transient = true;
    cause = cause.cause;
  }
  return transient;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function raceAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return operation;
  }

  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(createAbortError()), { once: true });
    }),
  ]);
}

function isTurnScopedEvent(event: AgentInternalEvent): event is AgentInternalEvent & { turnId: string } {
  return "turnId" in event && typeof (event as { turnId?: unknown }).turnId === "string";
}

function isTerminalTurnEvent(event: AgentInternalEvent) {
  return event.type === "turn.done" || event.type === "turn.failed" || event.type === "turn.aborted";
}

async function resolveConfiguredSystemPrompt(input: AgentConfig["systemPrompt"], runtime: AgentPluginRuntime): Promise<SystemModelMessage[]> {
  const value = typeof input === "function" ? await input(runtime) : input;
  return value === undefined ? [] : normalizeSystemPromptAppend(value);
}
