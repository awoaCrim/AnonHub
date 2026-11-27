import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { jsonSchema, type AgentPlugin, type AgentTool, type AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import { AppError, errorFields, logger, redact, toToolResult, type Clock, type ToolFailure } from "@yesimbot/foundation";
import { createToolPolicyHooks, guardToolPolicy, hasAllowedTools, PLATFORMS } from "koishi-plugin-yesimbot/kernel";
import type { ArtifactStore, ChannelContext, ChatAccount, ToolDescriptor } from "koishi-plugin-yesimbot/kernel";

import type { Config } from "./config.js";
import {
  ConfirmationStore,
  classifyToolRisk,
  deriveChannelScopeKey,
  hashArgs,
  inspectLatestConfirmationInput,
  pendingKey,
  type ConfirmationBlockReason,
  type PendingConfirmation,
} from "./confirmation.js";
import { MCP_ERRORS } from "./errors.js";
import { connectMcpServer } from "./transports.js";
import type { McpClientTransport } from "./types.js";

export const MCP_CLIENT_ID = "yesimbot-mcp-client";

const log = logger("yesimbot.mcp-client");

/** ponytail: align MCP media with Core's default image-input budget. */
const MCP_IMAGE_MAX_COUNT = 4;

const MCP_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const MCP_IMAGE_MAX_TOTAL_BYTES = 10 * 1024 * 1024;

const MCP_MAX_OUTPUT_CHARS = 30_000;

const MCP_MAX_BLOCK_TYPE_CHARS = 64;

const SUPPORTED_IMAGE_MIMES: Record<string, true> = { "image/jpeg": true, "image/png": true, "image/gif": true, "image/webp": true };

const MCP_ARTIFACT_GUIDANCE =
  "MCP 工具可能返回 artifact:// 媒体引用。这些是工具产生的不可变工件，不是内联媒体；" +
  "需要媒体内容时请调用 Core 的 read 工具。媒体不会是 Base64，远端 URL 也不会被自动下载；结果里公开的 https 图片网址可以直接交给 read 查看。";

const MCP_CONFIRMATION_GUIDANCE =
  "部分 MCP 工具会产生外部副作用。返回 confirmation_required 的调用没有被执行，也不代表操作已完成；" +
  "必须让用户在同一频道回复精确的「确认 <短码>」；若确认绑定已含发送者身份，后续消息必须保留可信原始身份并由同一发送者确认，身份丢失时不会执行。" +
  "不得自行编造或复用短码，也不得自行填写确认字段；参数变化、短码错误或确认过期后必须重新向用户确认。";

/** What a tool call hands back: the server's content blocks, or the registered failure when the call did not succeed. */
/** Content blocks, or a failure; a failure the server reported carries its own (redacted) text. */
export type McpToolOutput = Array<McpToolOutputBlock> | (ToolFailure & { serverMessage?: string });

export interface McpToolOutputBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/** What the service takes from Core: the conversation identity, the channel's artifact store, and publication of its tools. */
export interface McpHost {
  conversation(scope: ChannelContext): Promise<Parameters<typeof hasAllowedTools>[0]>;
  resources(scope: ChannelContext): Promise<{ artifacts: ArtifactStore }>;
  /** Publishes the service's per-channel plugin; the result withdraws it. */
  publish(plugin: { readonly id: string; setup(scope: ChannelContext, account: ChatAccount): Promise<AgentPlugin> }): () => void;
}

interface McpToolEntry {
  readonly serverName: string;
  readonly upstreamToolName: string;
  readonly requiresConfirmation: boolean;
  readonly tool: AgentTool;
}

/** The MCP client: connects the configured servers, lists their tools and offers them to every channel behind the confirmation gate. */
export class McpService {
  public readonly id = MCP_CLIENT_ID;

  private readonly confirmationStores = new Set<ConfirmationStore>();
  private transports: Map<string, McpClientTransport> = new Map();
  private clients: Map<string, Client> = new Map();
  private registeredTools: McpToolEntry[] = [];
  private disposeAgentPlugin?: () => void;

  public constructor(
    private readonly config: Config,
    private readonly host: McpHost,
    private readonly clock: Clock,
  ) {}

  public async setup(scope: ChannelContext, account: ChatAccount): Promise<AgentPlugin> {
    const accessScope = scope.selfId === undefined ? { ...scope, selfId: account.selfId } : scope;
    const conversation = await this.host.conversation(accessScope);
    // Same check as the tool gate: platform settings, chat kind and the enabled switch.
    const anyAllowed = (names: readonly string[]) =>
      hasAllowedTools(
        conversation,
        names.map((name) => ({
          name,
          pluginId: this.id,
          contexts: ["direct", "group"],
          capability: this.registeredTools.find((entry) => entry.tool.name === name)?.tool.capability,
        })),
      );
    if (!anyAllowed(this.registeredTools.map((entry) => entry.tool.name))) return { name: "mcp-client", tools: [] };

    const resources = await this.host.resources(accessScope);
    const scopeKey = deriveChannelScopeKey(accessScope);
    const confirmations = new ConfirmationStore(() => this.clock.now());
    this.confirmationStores.add(confirmations);
    const channelTools = this.registeredTools.map((entry) =>
      wrapToolWithArtifacts(this.withConfirmationGate(entry, scopeKey, confirmations), resources.artifacts),
    );
    const descriptors: ToolDescriptor[] = channelTools.map((tool) => ({
      name: tool.name,
      pluginId: this.id,
      contexts: ["direct", "group"],
      capability: tool.capability,
    }));
    const hasConfirmationTools = this.registeredTools.some((entry) => entry.requiresConfirmation);
    const appendSystemPrompt = () => (hasConfirmationTools ? `${MCP_ARTIFACT_GUIDANCE}\n${MCP_CONFIRMATION_GUIDANCE}` : MCP_ARTIFACT_GUIDANCE);
    return {
      name: "mcp-client",
      tools: guardToolPolicy(channelTools, conversation, descriptors),
      ...createToolPolicyHooks(conversation, descriptors),
      appendSystemPrompt,
      stop: () => {
        confirmations.clear();
        this.confirmationStores.delete(confirmations);
      },
    } satisfies AgentPlugin;
  }
  public async start(): Promise<void> {
    log.info("service.starting", { servers: Object.keys(this.config.mcpServers).length });

    for (const [name, server] of Object.entries(this.config.mcpServers)) {
      if (server.enable === false) {
        log.info("server.disabled", { server: name });
        continue;
      }

      try {
        const { client, transport } = await connectMcpServer(name, server);
        this.transports.set(name, transport);
        this.clients.set(name, client);
        log.info("server.connected", { server: name });
      } catch (error) {
        log.warn("server.connect_failed", { server: name, ...errorFields(error) });
      }
    }

    const registry = new Map<string, { client: Client; tools: Record<string, McpToolEntry> }>();

    const publishAgentPlugin = () => {
      // A catalog change invalidates every pre-refresh confirmation. Keep old runtime snapshots fail-closed.
      for (const confirmations of this.confirmationStores) confirmations.clear();
      this.registeredTools = [...registry.values()]
        .flatMap(({ tools }) => Object.values(tools))
        .sort((left, right) => left.tool.name.localeCompare(right.tool.name));

      for (const entry of this.registeredTools) {
        log.info("tool.registered", { tool: entry.tool.name, confirmation: entry.requiresConfirmation });
      }

      this.disposeAgentPlugin?.();
      this.disposeAgentPlugin = this.host.publish(this);
    };

    const refreshServerTools = async (name: string, client: Client) => {
      const resp = await client.listTools();
      const tools = resp.tools;
      log.info("server.tools_listed", { server: name, tools: tools.map((t) => t.name) });

      const entries: Record<string, McpToolEntry> = {};
      const usedExposedNames = new Set<string>();
      for (const tool of tools) {
        const exposedName = uniqueToolName(safeToolName(`${name}-${tool.name}`), usedExposedNames);
        entries[tool.name] = {
          serverName: name,
          upstreamToolName: tool.name,
          requiresConfirmation: this.config.mcpServers[name]?.requireConfirmation !== false && classifyToolRisk(tool.name, tool.description) === "side-effect",
          tool: {
            name: exposedName,
            // An explicitly connected MCP server is a private service bridge. Unknown upstream
            // tools stay sensitive and worker-only, regardless of their own risk annotations.
            capability: { platforms: PLATFORMS.map((platform) => platform.id), sensitive: true, executionKind: "service" },
            description: tool.description,
            inputSchema: jsonSchema(tool.inputSchema),
            execute: async (params: unknown): Promise<McpToolOutput> => {
              let result: Awaited<ReturnType<Client["callTool"]>>;
              try {
                result = await client.callTool({ name: tool.name, arguments: structuredClone(params as Record<string, unknown>) });
              } catch (cause) {
                // Whether the server acted is unknown; the model reads the registered sentence, the log keeps the cause.
                const error = new AppError(MCP_ERRORS.mcp_call_failed, { effect: "unknown", cause });
                log.warn("tool.call_failed", { tool: exposedName, server: name, ...errorFields(error) });
                return toToolResult(error);
              }
              // The server answered, but with `isError`: the tool itself failed, which is not a success. Its own text is the
              // tool's answer, as on success, so the model sees it (redacted, bounded) to correct its call (MCP spec).
              if (result.isError === true) {
                const serverMessage = describeContent(result.content);
                log.warn("tool.reported_error", { tool: exposedName, server: name, upstream: serverMessage });
                return { ...toToolResult(new AppError(MCP_ERRORS.mcp_tool_failed, { effect: "unknown" })), serverMessage: redact(serverMessage) };
              }
              return result.content as Array<McpToolOutputBlock>;
            },
          } satisfies AgentTool,
        };
      }

      registry.set(name, { client, tools: entries });
    };

    for (const [name, client] of this.clients.entries()) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        try {
          await refreshServerTools(name, client);
          publishAgentPlugin();
        } catch (error) {
          log.warn("server.refresh_failed", { server: name, ...errorFields(error) });
        }
      });
      await refreshServerTools(name, client);
    }

    publishAgentPlugin();

    log.info("service.started", { tools: this.registeredTools.length });
  }

  public async stop(): Promise<void> {
    log.info("service.stopping");
    this.disposeAgentPlugin?.();
    this.disposeAgentPlugin = undefined;
    for (const confirmations of this.confirmationStores) confirmations.clear();
    this.confirmationStores.clear();

    for (const [name, client] of this.clients.entries()) {
      try {
        await client.close();
        log.info("server.closed", { server: name });
      } catch (error) {
        log.warn("server.close_failed", { server: name, ...errorFields(error) });
      }
    }

    for (const [name, transport] of this.transports.entries()) {
      try {
        await transport.close();
        log.info("transport.closed", { server: name });
      } catch (error) {
        log.warn("transport.close_failed", { server: name, ...errorFields(error) });
      }
    }

    this.clients.clear();
    this.transports.clear();
    log.info("service.stopped");
  }

  /** Wraps side-effect tools with the pre-upstream confirmation gate; read-only tools stay untouched. */
  private withConfirmationGate(entry: McpToolEntry, scopeKey: string | undefined, confirmations: ConfirmationStore): AgentTool {
    if (!entry.requiresConfirmation) {
      return entry.tool;
    }

    return {
      ...entry.tool,
      execute: (input: unknown, options: AgentToolExecuteContext) => this.runConfirmationGate(entry, scopeKey, confirmations, input, options),
    };
  }

  private async runConfirmationGate(
    entry: McpToolEntry,
    scopeKey: string | undefined,
    confirmations: ConfirmationStore,
    input: unknown,
    options: AgentToolExecuteContext,
  ): Promise<McpToolOutput> {
    if (scopeKey === undefined) {
      return confirmationUnavailableOutput(entry.tool.name, "scope-unavailable", "无法确定当前频道，确认状态不可绑定");
    }

    let argsHash: string;
    try {
      argsHash = hashArgs(input);
    } catch (cause) {
      log.warn("confirmation.args_unhashable", { tool: entry.tool.name, ...errorFields(cause) });
      return confirmationUnavailableOutput(entry.tool.name, "args-unhashable", "调用参数无法规范化，无法建立参数绑定");
    }

    const observation = inspectLatestConfirmationInput(options?.messages);
    const actorId = observation.latest?.actorId;
    const registrationBase = { channelKey: scopeKey, serverName: entry.serverName, upstreamToolName: entry.upstreamToolName, argsHash };
    const inputTrace = {
      argsHash: argsHash.slice(0, 12),
      actorId,
      currentMessageCount: options?.messages?.length ?? 0,
      currentCarrierCount: observation.carriers.length,
      currentCarriers: observation.carriers.slice(-8).map((carrier) => ({
        carrier: carrier.carrier,
        ...(carrier.platformMessageId ? { platformMessageId: carrier.platformMessageId } : {}),
        ...(carrier.agentMessageId ? { agentMessageId: carrier.agentMessageId } : {}),
        ...(carrier.actorId ? { actorId: carrier.actorId } : {}),
        codeState: carrier.codeState,
      })),
      latestCarrier: observation.latest?.carrier ?? "none",
      latestPlatformMessageId: observation.latest?.platformMessageId,
      latestAgentMessageId: observation.latest?.agentMessageId,
      confirmationState: observation.latest?.codeState ?? "absent",
    };

    // Do not create a parallel actorless pending entry when a previous request is already bound to a
    // concrete sender. That would rotate the displayed code while hiding the missing trusted carrier.
    if (actorId === undefined) {
      const actorBoundPending = confirmations.findByArgs(registrationBase).filter((pending) => pending.actorId !== undefined);
      if (actorBoundPending.length > 0) {
        const bindingHash = hashArgs({ ...registrationBase, actorId: null }).slice(0, 16);
        log.debug("confirmation.blocked", {
          bindingHash,
          ...inputTrace,
          pendingActorIds: actorBoundPending.flatMap((pending) => (pending.actorId ? [pending.actorId] : [])),
          reason: "trusted-actor-unavailable",
        });
        return confirmationUnavailableOutput(entry.tool.name, "trusted-actor-unavailable", "当前消息没有可信发送者身份，无法消费已绑定到具体发送者的确认");
      }
    }

    const registration = { ...registrationBase, actorId };
    const pending = confirmations.register(registration);
    const provided = observation.code;
    const bindingHash = hashArgs({
      channelKey: scopeKey,
      serverName: entry.serverName,
      upstreamToolName: entry.upstreamToolName,
      actorId: actorId ?? null,
      argsHash,
    }).slice(0, 16);
    const trace = {
      bindingHash,
      ...inputTrace,
      pendingActorId: pending.actorId,
      codeMatches: provided !== undefined && provided === pending.code,
    };
    log.debug("confirmation.binding", trace);

    if (provided === undefined || provided !== pending.code) {
      const reason = provided === undefined ? "awaiting-confirmation" : "short-code-mismatch";
      log.debug("confirmation.blocked", { ...trace, reason });
      return confirmationRequiredOutput(entry, pending, this.clock.now(), reason);
    }

    // Consume before the upstream call: a failure, retry, or duplicate must never reuse the same code.
    const consumed = confirmations.consume(pendingKey(scopeKey, entry.serverName, entry.upstreamToolName, actorId));
    const consumedMatches = consumed !== undefined && consumed.code === provided;
    log.debug("confirmation.consume", { ...trace, consumed: consumedMatches });
    if (!consumedMatches) {
      log.debug("confirmation.stale", { tool: entry.tool.name });
      return confirmationRequiredOutput(entry, pending, this.clock.now(), "stale-pending");
    }

    log.info("confirmation.accepted", { tool: entry.tool.name });
    const output = await entry.tool.execute(input, options);
    return (output ?? []) as McpToolOutput;
  }
}

function confirmationRequiredOutput(
  entry: McpToolEntry,
  pending: PendingConfirmation,
  now: number,
  reason: ConfirmationBlockReason,
): Array<McpToolOutputBlock> {
  const remainingMs = Math.max(0, pending.expiresAt - now);
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const lines = [
    "confirmation_required",
    `工具 ${entry.tool.name}（MCP server: ${entry.serverName}）可能产生外部副作用，本次调用没有执行，上游未被请求。`,
    `reason: ${reason}`,
    `参数指纹: ${pending.argsHash.slice(0, 12)}`,
    `确认短码: ${pending.code}（${minutes} 分钟内有效，仅可使用一次）`,
    `请让用户在同一频道回复精确的「确认 ${pending.code}」；若该确认已绑定发送者，后续消息必须保留可信原始身份并由同一发送者确认，身份丢失时不会执行。`,
    "在收到有效确认前，不得声称已下单、已支付、已取消或已完成。",
  ];
  return [{ type: "text", text: lines.join("\n").slice(0, MCP_MAX_OUTPUT_CHARS) }];
}

function confirmationUnavailableOutput(toolName: string, reason: ConfirmationBlockReason, detail: string): Array<McpToolOutputBlock> {
  const lines = [
    "confirmation_unavailable",
    `工具 ${toolName} 无法建立确认绑定（reason: ${reason}）：${detail}。`,
    "本次调用没有执行，上游未被请求；不要重复尝试该调用。",
  ];
  return [{ type: "text", text: lines.join("\n").slice(0, MCP_MAX_OUTPUT_CHARS) }];
}

function safeToolName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
  return normalized || "mcp";
}

function uniqueToolName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) {
    suffix += 1;
  }

  const unique = `${base}_${suffix}`;
  used.add(unique);
  return unique;
}

function wrapToolWithArtifacts(tool: AgentTool, artifacts: ArtifactStore): AgentTool {
  const writer = artifacts.forTool(tool.name);
  return {
    ...tool,
    toModelOutput: async (options) => {
      const { output } = options as { output: McpToolOutput };
      // A failed call is the registered failure object, not content blocks.
      if (output && !Array.isArray(output)) return { type: "json" as const, value: output as never };
      if (!output || output.length === 0) {
        return { type: "text" as const, value: "" };
      }

      const lines: string[] = [];
      let imageCount = 0;
      let imageBytes = 0;
      for (const block of output) {
        if (!block || typeof block !== "object") {
          lines.push("[不支持的内容块：unknown]");
          continue;
        }
        if (block.type === "text") {
          lines.push(block.text ?? "");
          continue;
        }

        const mediaType = typeof block.mimeType === "string" ? block.mimeType.toLowerCase() : undefined;
        if (block.type === "image" && typeof block.data === "string" && mediaType !== undefined && SUPPORTED_IMAGE_MIMES[mediaType]) {
          const bytes = decodeInlineImage(block.data);
          if (!bytes) {
            lines.push("[图片资源：数据无效或大小超出限制]");
            continue;
          }
          if (imageCount >= MCP_IMAGE_MAX_COUNT || imageBytes + bytes.byteLength > MCP_IMAGE_MAX_TOTAL_BYTES) {
            lines.push("[图片资源：超出图片限制]");
            continue;
          }
          try {
            const uri = await writer.put(bytes, { mediaType, filename: "mcp-image" });
            imageCount += 1;
            imageBytes += bytes.byteLength;
            lines.push(`[图片：${uri}（${mediaType}，${formatBytes(bytes.byteLength)}）]`);
          } catch (cause) {
            log.warn("artifact.write_failed", { tool: tool.name, ...errorFields(cause) });
            lines.push("[图片资源：持久化失败]");
          }
          continue;
        }
        // Unknown or unsupported blocks become bounded descriptions, never opaque JSON.
        lines.push(`[不支持的内容块：${describeBlockType(block.type)}]`);
      }

      const value = lines.join("\n").trim().slice(0, MCP_MAX_OUTPUT_CHARS);
      return { type: "text" as const, value };
    },
  };
}

function decodeInlineImage(data: string): Uint8Array | null {
  if (data.length === 0 || data.length > Math.ceil(MCP_IMAGE_MAX_BYTES / 3) * 4) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) return null;
  const bytes = Buffer.from(data, "base64");
  return bytes.byteLength > 0 && bytes.byteLength <= MCP_IMAGE_MAX_BYTES ? bytes : null;
}

function describeBlockType(type: string): string {
  return type.length > MCP_MAX_BLOCK_TYPE_CHARS ? `${type.slice(0, MCP_MAX_BLOCK_TYPE_CHARS)}…` : type;
}

function formatBytes(length: number): string {
  if (length >= 1024 * 1024) return `${(length / (1024 * 1024)).toFixed(1)} MiB`;
  if (length >= 1024) return `${(length / 1024).toFixed(1)} KiB`;
  return `${length} B`;
}

/** The text of an `isError` answer, bounded. */
function describeContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? [String((block as { text?: unknown }).text ?? "")] : [],
    )
    .join("\n")
    .slice(0, 500);
}
