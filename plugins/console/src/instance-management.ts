import type { AgentTool, AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import type { GoogleConnector } from "@yesimbot/contracts";
import { AppError, errorEntry, newId } from "@yesimbot/foundation";
import type { ChatAccount } from "koishi-plugin-yesimbot/kernel";
import { toolActors, type ChannelContext } from "koishi-plugin-yesimbot/kernel";
import { z } from "zod/v4";

import { collectSecretValues, isObject } from "./config/secrets.js";
import { ConfigError, ConfigStore } from "./config/store.js";
import type { Host } from "./host.js";
import { createWorkTools, WORK_ERRORS } from "./instance-work.js";
import { deviceFileBytes, installMcpScript, MCP_SCRIPT_ERRORS, MCP_SCRIPT_MAX_BYTES, mcpScriptName } from "./mcp-scripts.js";
import type { MemoryService } from "./memory-service.js";
import { pluginBaseName } from "./shared/plugin-catalog.js";
import { isWebChatTransport, type WebChatTransport } from "./webui/chat-bot.js";
import { extensionItems } from "./webui/extensions.js";
import { sharedAppConfigured } from "./webui/google.js";

const CONFIG = { path: z.string(), revision: z.string(), config: z.record(z.string(), z.unknown()), enabled: z.boolean() };
const MEMORY_ERRORS = new Map([
  ["memory_unavailable", 503],
  ["memory_not_found", 404],
  ["memory_revision_conflict", 409],
  ["invalid_memory_page", 400],
  ["invalid_memory_content", 400],
  ["invalid_memory_visibility", 400],
]);
const SAFE_ERRORS = new Set<string>([
  ...WORK_ERRORS,
  ...MCP_SCRIPT_ERRORS,
  "invalid_instance_request",
  "instance_authentication_required",
  "schema_unavailable",
]);
interface InstanceToolContext {
  scope: ChannelContext;
  bot: ChatAccount;
  role: "main" | "computer" | "content" | "service";
  logSecrets: Set<string>;
}

/** All targets are closed over this runtime's stores. No instance/account/filesystem target is accepted. */
export function createInstanceTools(ctx: Host, store: ConfigStore, context: InstanceToolContext): AgentTool[] {
  const { scope, bot, role, logSecrets } = context;
  const core = ctx.yesimbot;
  const identity = core.identity;
  const trusted = () => isWebChatTransport(bot) && bot.belongsToRuntime(core) && ctx.yesimbot.identity === identity && bot.isAuthenticatedContext(scope);
  if (!trusted()) return [];
  const ensure = () => {
    if (!trusted()) throw Error("instance_authentication_required");
  };
  const memoryService = () => {
    const memory = ctx.get("yesimbotMemory") as MemoryService | undefined;
    if (!memory) throw Error("memory_unavailable");
    return memory;
  };
  const editable = async (path: string) => {
    const entry = store.resolve(path);
    const schema = await store.catalog.schema(pluginBaseName(entry.key));
    if (!schema.schema) throw Error("schema_unavailable");
    ensure();
    return schema;
  };
  const tool = (
    name: string,
    description: string,
    write: boolean,
    shape: z.ZodRawShape,
    action: (value: Record<string, unknown>, authorize: () => void, execution: AgentToolExecuteContext) => Promise<unknown> | unknown,
  ): AgentTool => ({
    name,
    description,
    capability: { platforms: ["web"], contexts: ["direct"], sensitive: true, executionKind: write ? "service" : "read" },
    inputSchema: z.strictObject(shape),
    execute: async (value, execution) => {
      try {
        ensure();
        const authenticated = (bot as unknown as WebChatTransport).captureAuthentication(scope);
        const authorize = () => {
          ensure();
          if (!authenticated()) throw Error("instance_authentication_required");
        };
        authorize();
        // The main agent does simple changes itself, like Muse; a computer or content worker never changes the instance.
        if (write && role !== "main" && role !== "service") throw Error("instance_authentication_required");
        const result = await action(input(value, Object.keys(shape)), authorize, execution);
        authorize();
        return result;
      } catch (error) {
        if (error instanceof ConfigError)
          return {
            error: error.code,
            status: error.status,
            ...(error.path ? { path: error.path } : {}),
            ...(error.restored !== undefined ? { restored: error.restored } : {}),
          };
        const message = error instanceof Error ? error.message : "";
        if (MEMORY_ERRORS.has(message)) return { error: message, status: MEMORY_ERRORS.get(message) };
        if (SAFE_ERRORS.has(message)) return { error: message };
        // Any other registered error (an install refused) says itself.
        return { error: error instanceof AppError && errorEntry(error.code) ? error.code : "instance_operation_failed" };
      }
    },
  });
  const reads: AgentTool[] = [
    tool(
      "instance_memory_read",
      "读取当前实例的长期记忆（只读）。action=list 分页列出全部有效长期记忆（含待审阅旧记忆）的摘要、id、visibility 和 revision，不按关键词筛选，可选 limit（默认 50，最多 200）和 cursor；有 nextCursor 时需继续分页，读完才能判断全库为空。action=read 按目录中的 id 读取一条记忆的完整正文、visibility 与 revision，需要 id，不返回原始证据、聊天记录或文件路径。此目录不是聊天历史，recall 为空也不代表全库为空。修改或删除用 instance_memory_write，携带刚读取的 revision。",
      false,
      {
        action: z.enum(["list", "read"]),
        id: z.string().max(256).optional(),
        limit: z.int().min(1).max(200).optional(),
        cursor: z.string().max(512).optional(),
      },
      async (value) => {
        if (value.action === "read") return need(value, "id") ?? memoryService().read(memoryId(value.id));
        const limit = value.limit ?? 50;
        if (
          !Number.isInteger(limit) ||
          (limit as number) < 1 ||
          (limit as number) > 200 ||
          (value.cursor !== undefined && (typeof value.cursor !== "string" || value.cursor.length > 512))
        )
          throw Error("invalid_instance_request");
        const page = await memoryService().list({ limit: limit as number, ...(value.cursor !== undefined ? { cursor: value.cursor as string } : {}) });
        return {
          memories: page.memories.map(({ id, content, type, visibility, revision, updatedAt, source }) => ({
            id,
            summary: Array.from(content).slice(0, 160).join(""),
            type,
            visibility,
            revision,
            updatedAt,
            source,
          })),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      },
    ),
    tool(
      "instance_config_read",
      "读取本实例可自行管理的插件配置（只读）。action=list 读取配置目录与当前 revision，宿主基础设施不在可修改范围；action=read 读取单个插件的配置和 schema，需要 path，秘密字段返回保留标记。修改配置用 instance_config_write，携带本次 revision。",
      false,
      { action: z.enum(["list", "read"]), path: CONFIG.path.optional() },
      async (value) => {
        if (value.action === "list") return store.catalog.snapshot();
        const missing = need(value, "path");
        if (missing) return missing;
        const path = string(value.path);
        const schema = await editable(path);
        const snapshot = await store.read(path);
        return { ...snapshot, ...schema };
      },
    ),
    tool(
      "instance_extension_read",
      "列出本实例从 npm 安装的扩展：包名、版本、模块 ID（module）、状态（installing 安装中、running 运行中、disabled 已停用、waiting、failed）和失败原因（error）。扩展的设置就是它模块的配置，用 instance_config_read / instance_config_write 读改，路径就是模块 ID。安装、移除用 instance_extension_write。",
      false,
      {},
      () => ({ items: extensionItems(ctx) }),
    ),
    tool(
      "instance_connections",
      "只读：查看本实例可用的服务连接和安全账户摘要。连接或重新授权由用户在网页「设置 → 服务连接」（settingsPath）完成；本工具不会在对话里放按钮，返回结果也不代表已经连接。",
      false,
      {},
      async (_value, authorize) => {
        if (!store.permitted("yesimbot-google")) return { services: [] };
        const connector = ctx.get("yesimbotGoogle") as GoogleConnector | undefined;
        const snapshot = connector
          ? await connector.snapshot()
          : { available: true, configured: process.env.YESIMBOT_TENANT_ID ? sharedAppConfigured() : false, accounts: [] };
        authorize();
        // Pick the public fields even if a connector implementation accidentally adds a credential.
        return {
          services: [
            {
              id: "google",
              label: "Google",
              available: snapshot.available,
              configured: snapshot.configured,
              accounts: snapshot.accounts.map((account) => ({
                id: account.id,
                email: account.email,
                ...(account.name ? { name: account.name } : {}),
                permissions: account.permissions,
                connectedAt: account.connectedAt,
                needsReconnect: account.needsReconnect,
              })),
              // A fixed page in this console; nothing in the chat changes when the bot reads this.
              settingsPath: "/settings/connections",
            },
          ],
        };
      },
    ),
  ];
  const work = createWorkTools(ctx, tool, () => store.permitted("yesimbot-schedule"));
  reads.push(...work.reads);
  if (role !== "main" && role !== "service") return reads;
  return [
    ...reads,
    ...work.writes,
    tool(
      "instance_memory_write",
      "按用户明确要求修改或删除本实例已选中的长期记忆；先用 instance_memory_read 读取，并携带最新 revision，冲突时重新读取。action=update 修改正文，需要 id、revision、content；只编辑正文时省略 visibility，保留原范围，改变范围须显式选择，visibility=shared 会向本实例其他会话公开正文，必须是用户明确选择。action=delete 删除记忆及其记忆证据文件，需要 id、revision；删除不会删除聊天历史、会话摘要或归档，也不能代替清空聊天记录。聊天历史和原始证据不由此编辑。",
      true,
      {
        action: z.enum(["update", "delete"]),
        id: z.string().max(256),
        revision: z.int().min(0).optional(),
        content: z.string().max(16000).optional(),
        visibility: z.enum(["owner", "conversation", "shared"]).optional(),
      },
      (value, authorize) => {
        const missing = need(value, "revision", ...(value.action === "update" ? ["content"] : []));
        if (missing) return missing;
        if (value.action === "delete") return memoryService().delete({ id: memoryId(value.id), revision: memoryRevision(value.revision) }, authorize);
        if (typeof value.content !== "string" || (value.visibility !== undefined && !["owner", "conversation", "shared"].includes(String(value.visibility))))
          throw Error("invalid_instance_request");
        return memoryService().update(
          {
            id: memoryId(value.id),
            revision: memoryRevision(value.revision),
            content: value.content,
            ...(value.visibility !== undefined ? { visibility: value.visibility as "owner" | "conversation" | "shared" } : {}),
          },
          authorize,
        );
      },
    ),
    tool(
      "instance_config_write",
      "修改本实例单个插件的配置，必须携带最新 revision；先用 instance_config_read 读取 schema，保留秘密标记和未知字段，验证、应用与失败回滚复用 ConfigStore。action=update 更新配置，需要 path、revision、config；action=set_enabled 启用或停用已有插件，需要 path、revision、enabled，不会安装新的原生 Koishi 插件。",
      true,
      {
        action: z.enum(["update", "set_enabled"]),
        path: CONFIG.path,
        revision: CONFIG.revision,
        config: CONFIG.config.optional(),
        enabled: CONFIG.enabled.optional(),
      },
      async (value, authorize) => {
        const missing = need(value, value.action === "update" ? "config" : "enabled");
        if (missing) return missing;
        const path = string(value.path);
        if (value.action === "set_enabled") {
          if (typeof value.enabled !== "boolean") throw Error("invalid_instance_request");
          return store.setEnabled(revision(value.revision), path, value.enabled, authorize);
        }
        const current = revision(value.revision);
        if (!isObject(value.config)) throw Error("invalid_instance_request");
        const { schema, dynamics } = await editable(path);
        for (const secret of collectSecretValues(value.config, schema, dynamics)) logSecrets.add(secret);
        return store.update(current, path, value.config, authorize);
      },
    ),
    tool(
      "instance_extension_write",
      "从 npm 安装或移除本实例的扩展。扩展是在本实例主程序里运行的代码，只装用户点名或明确同意的包。action=install 需要 name（npm 包名），version 可选（1.2.3 这样的确定版本，不填装最新版）；在后台安装，返回后用 instance_extension_read 查看结果，装好即启用，需要填设置时按它模块的 schema 用 instance_config_write 改。action=remove 需要 name：停用扩展，删除它的设置和安装文件，它写下的数据保留。",
      true,
      { action: z.enum(["install", "remove"]), name: z.string().max(214), version: z.string().max(80).optional() },
      async (value, authorize) => {
        authorize();
        if (value.action === "install") return { ...ctx.extensions.install(value.name, value.version), status: "installing" };
        await ctx.extensions.remove(value.name);
        return { ok: true };
      },
    ),
    tool(
      "instance_mcp_script_install",
      `把当前会话所用电脑上的一个 MCP 脚本复制到本实例 Koishi 主程序所在服务器的 MCP 目录，返回它在服务器上的绝对路径和可直接用的 stdio 配置（command 为 node，args 为该路径）。path 是电脑上当前会话工作目录里的相对路径；name 可选，默认用原文件名，同名会覆盖。只支持 Node.js 脚本（.mjs/.cjs/.js，最大 ${MCP_SCRIPT_MAX_BYTES / 1024} KB），服务器不会替它安装依赖，只能用 Node 自带模块。覆盖已在用的脚本后，要重新保存对应的 mcpServers 配置才会换成新脚本。`,
      true,
      { path: z.string().max(4096), name: z.string().max(64).optional() },
      async (value, authorize, execution) => {
        const path = string(value.path);
        const name = mcpScriptName(path, value.name === undefined ? undefined : string(value.name));
        const devices = ctx.yesimbot.devices;
        const deviceId = devices.workspaceDevice(scope);
        if (!deviceId) throw Error("mcp_computer_unavailable");
        const result = await devices.invoke(
          deviceId,
          {
            scope,
            actors: toolActors(execution.messages, scope.platform),
            operationId: newId(),
            capability: "workspace.files",
            method: "read",
            input: { path },
            expiresAt: ctx.clock.now() + 30_000,
          },
          execution.abortSignal,
        );
        // The computer's own answer (missing file, refused path) is the useful part for the bot.
        if (result.status !== "succeeded")
          return { error: "mcp_script_read_failed", computer: { status: result.status, ...("code" in result && result.code ? { code: result.code } : {}) } };
        const bytes = deviceFileBytes(result.output);
        authorize();
        return installMcpScript(ctx.baseDir, name, bytes);
      },
    ),
  ];
}

/** Register as a normal channel plugin, so service workers receive the same trusted stores. */
export function installInstanceManagement(ctx: Host, logSecrets: Set<string>) {
  const store = new ConfigStore(ctx, { selfService: true });
  ctx.on("internal/schema", () => store.catalog.invalidate());
  ctx.on("config", () => store.catalog.invalidate());
  ctx.inject(["yesimbot"], (scope) => {
    const dispose = scope.yesimbot.agent.use({
      id: "yesimbot-instance-management",
      setup: (context, bot, runtime) => {
        const tools = createInstanceTools(scope, store, { scope: context, bot, role: runtime?.executionRole ?? "main", logSecrets });
        return tools.length
          ? {
              name: "instance-management",
              tools,
              appendSystemPrompt: () =>
                "你可以查看和管理这个实例：配置、扩展、连接、长期记忆，以及所有会话的后台任务（instance_tasks、instance_task_control）和定时任务（instance_schedules、instance_schedule_update、instance_schedule_delete）。task_*、schedule_* 只管当前会话，instance_* 管全部会话。简单的改动自己直接做，又长又多步骤的交给后台任务。recall 是当前会话获授权的相关记忆检索，空结果不代表全库为空；全库盘点使用 instance_memory_read 的 action=list 并跟进 nextCursor，正文按需 instance_memory_read（action=read）。长期记忆与聊天历史、摘要、归档独立，删改记忆不会清空聊天记录。删改记忆、删除定时任务、取消任务都要按用户明确要求；改动前先读最新 revision，改配置还须先读 schema，并以工具回执核实结果。连接入口需要用户在浏览器授权，不得声称已连接。" +
                "管理员（只有他们能让你调用敏感工具）由账号持有人在控制台的「平台」页登记；你读不到、也改不了，不要尝试改配置来增减管理员，也不要让别人以为你能改。工具能否使用由代码声明决定，配置里没有工具开关。QQ 群的禁言、解禁、踢人按群开启：把群号加入 yesimbot-onebot-utils 的 moderationGroups，之后该群群主或管理员提出的要求它才执行，它自己也须是群管理员。" +
                "MCP 服务器在 yesimbot-mcp-client 的 mcpServers 里，你可以直接添加、修改、停用：http/sse 填地址；stdio 是在宿主程序所在的服务器上运行的命令，不在用户电脑上，电脑上的文件路径服务器看不到：自己写的 Node 脚本先在电脑上测好，再用 instance_mcp_script_install 复制到服务器，按它返回的 stdio（command node、args 为返回的路径）配置；现成的包也可以用 npx 等方式获取。已有 env、headers 读回时是隐藏标记，原样传回即保留，整体替换时须给出完整的新值。加完读一次配置并看工具是否出现来核实。",
            }
          : null;
      },
    });
    scope.on("dispose", dispose);
  });
  return { store };
}

/** A call that omits a field its action needs is refused with what to add, not run. */
function need(value: Record<string, unknown>, ...fields: string[]) {
  const missing = fields.filter((field) => value[field] === undefined);
  return missing.length
    ? { status: "rejected" as const, code: "invalid_instance_request", message: `action=${String(value.action)} 需要 ${missing.join("、")}。` }
    : undefined;
}

function input(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).some((key) => !allowed.includes(key)) || JSON.stringify(value).length > 256 * 1024)
    throw Error("invalid_instance_request");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024) throw Error("invalid_instance_request");
  return value;
}

function revision(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw Error("invalid_instance_request");
  return value;
}

function memoryId(value: unknown): string {
  const id = string(value);
  if (id.length > 256 || id.includes("/") || id.includes("\\") || Array.from(id).some((character) => character.codePointAt(0)! < 32))
    throw Error("invalid_instance_request");
  return id;
}

function memoryRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw Error("invalid_instance_request");
  return value as number;
}
