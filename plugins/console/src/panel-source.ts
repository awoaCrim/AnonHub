import { freemem, totalmem } from "node:os";

import { platformDefinition, platformLabel, platformOfAdapter, PLATFORMS, WEB_CHAT } from "@yesimbot/contracts/platforms";
import { errorUserText, type Event as YesImBotEvent } from "koishi-plugin-yesimbot/kernel";

import { BOT_ONLINE, type Host } from "./host.js";
import type { QQPresence } from "./qq-presence.js";
import type { PanelPayload, PanelPlugin, PanelAdapter, PanelIssue, PanelRecent, PanelOnboardingStep, PanelOnboarding } from "./shared/panel.js";

const REFRESH_INTERVAL = 5_000;
const PLUGIN_LABELS: Record<string, string> = {
  yesimbot: "核心",
  "yesimbot-model-provider": "模型接入",
  "yesimbot-console": "控制台",
  "yesimbot-mcp-client": "MCP 工具",
  "yesimbot-onebot-utils": "QQ 专属动作",
  "yesimbot-roleplay": "角色扮演",
  "yesimbot-schedule": "定时任务",
  "yesimbot-search-service": "搜索服务",
  "yesimbot-sticker-manager": "表情包",
  "yesimbot-usage": "用量统计",
  "yesimbot-workspace": "工作区",
};

const PLUGIN_ORDER = [
  "yesimbot",
  "yesimbot-model-provider",
  "yesimbot-workspace",
  "yesimbot-mcp-client",
  "yesimbot-search-service",
  "yesimbot-schedule",
  "yesimbot-sticker-manager",
  "yesimbot-onebot-utils",
  "yesimbot-roleplay",
  "yesimbot-usage",
  "yesimbot-console",
];

/** The WebUI's overview topic: owns delivery-failure history and a periodic refresh signal. */
export class PanelSource {
  private disposed = false;
  private recent: PanelRecent[] = [];
  private readonly listeners = new Set<() => void>();

  public constructor(
    public readonly ctx: Host,
    private readonly presence?: QQPresence,
  ) {
    const refreshSoon = ctx.debounce(() => this.changed(), 500);
    ctx.on("yesimbot/event", (event) => {
      if (this.recordEvent(event)) refreshSoon();
    });
    ctx.on("ready", () => {
      this.changed();
      ctx.setInterval(() => this.changed(), REFRESH_INTERVAL);
    });
    ctx.on("dispose", () => {
      this.disposed = true;
      this.listeners.clear();
    });
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async get(): Promise<PanelPayload | null> {
    if (this.disposed || !this.ctx.yesimbot) return null;
    return buildPanelPayload(this.ctx, this.recent, this.presence);
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private recordEvent(event: YesImBotEvent): boolean {
    const data = event.data as {
      eventType?: string;
      platform?: string;
      channel?: { id?: string };
      delivery?: { error?: { message?: string } };
    };
    if (data.eventType !== "delivery.failed") return false;
    this.recent.unshift({
      timestamp: new Date(this.ctx.clock.now()).toISOString(),
      level: "error",
      type: data.eventType,
      message: data.delivery?.error?.message ?? "消息投递失败",
      channel: `${data.platform ?? ""}:${data.channel?.id ?? ""}`,
    });
    this.recent = this.recent.slice(0, 30);
    return true;
  }
}

export function buildPanelPayload(ctx: Host, recent: PanelRecent[], presence?: QQPresence): PanelPayload {
  const issues: PanelIssue[] = [];
  const plugins = collectPlugins(ctx);
  const coreConfig = readCoreConfig(ctx);
  const model = readModelState(ctx, coreConfig, issues);
  const adapters = collectAdapters(ctx, presence);
  const onboarding = buildOnboarding(ctx, coreConfig, model.providers.length > 0, adapters);
  // Platform connections only: the built-in web chat is not a connected account.
  const bots = Array.from(ctx.bots).filter((bot) => bot.platform !== WEB_CHAT.platform);
  const botErrorCount = bots.filter((bot) => Boolean(bot.error)).length;
  const total = totalmem();
  const free = freemem();
  const rss = process.memoryUsage().rss;

  if (coreConfig.allowedChannels === 0) {
    issues.push({ level: "warning", message: "回复范围尚未添加" });
  }
  if (botErrorCount > 0) {
    issues.push({ level: "warning", message: `${botErrorCount} 个平台连接出错` });
  }
  for (const plugin of plugins) {
    if (plugin.status === "attention") issues.push({ level: "warning", message: plugin.detail });
  }

  return {
    generatedAt: new Date(ctx.clock.now()).toISOString(),
    health: {
      online: true,
      botCount: bots.length,
      botErrorCount,
      memory: { app: rss / total, total: 1 - free / total },
      uptimeSeconds: Math.floor(process.uptime()),
    },
    model,
    config: coreConfig,
    plugins,
    adapters,
    onboarding,
    recent,
    attention: issues,
  };
}

function buildOnboarding(ctx: Host, coreConfig: ReturnType<typeof readCoreConfig>, hasProvider: boolean, adapters: PanelAdapter[]): PanelOnboarding {
  // A QQ kicked offline is still a connected platform: setup is done, the account needs signing in again.
  const adapterDone = adapters.some((adapter) => adapter.state === "online" || adapter.state === "offline");
  const enabledAdapter = adapters.find((adapter) => adapter.enabled);
  const adapterTarget = enabledAdapter?.configPath ? `/plugins/${enabledAdapter.configPath}` : "/plugins/adapter";
  const adapterDescription = adapterDone
    ? "聊天账号已在线。"
    : !adapters.length
      ? "可以接入 QQ 或微信。"
      : !adapters.some((adapter) => adapter.enabled)
        ? "启用需要的聊天接入插件。"
        : "完成所选聊天账号的登录，等待账号在线。";
  const plugins = flattenPluginConfig(ctx.loader.config.plugins ?? {});
  const providerKeys = Object.keys(plugins).filter((key) => normalizePluginKey(key) === "yesimbot-model-provider");
  // Only when the roleplay plugin is installed: without it the bot speaks with its default persona.
  const roleKeys = Object.keys(plugins).filter((key) => normalizePluginKey(key) === "yesimbot-roleplay");
  const roleKey = roleKeys.find((key) => !key.startsWith("~")) ?? roleKeys[0];
  const role = (roleKey ? plugins[roleKey] : undefined) as Record<string, unknown> | null | undefined;
  const roleSet = typeof role?.characterCard === "string" && role.characterCard.trim().length > 0;
  const providerKey = providerKeys.find((key) => !key.startsWith("~")) ?? providerKeys[0];
  const steps: PanelOnboardingStep[] = [
    {
      id: "adapter",
      title: "连接聊天账号",
      description: adapterDescription,
      target: adapterTarget,
      done: adapterDone,
    },
    {
      id: "model",
      title: "连接模型服务",
      description: "填写模型服务的地址和密钥，并选择用来回复的模型。",
      target: hasProvider ? `/plugins/${coreConfig.configPath}` : `/plugins/${providerKey ? instancePath(providerKey) : "yesimbot-model-provider"}`,
      done: hasProvider && Boolean(coreConfig.chatModel),
    },
    ...(roleKey
      ? [
          {
            id: "role" as const,
            title: "选择角色",
            description: "填写角色的名字和性格，或导入 PNG 角色卡，机器人会按设定说话。",
            target: `/plugins/${instancePath(roleKey)}`,
            done: !roleKey.startsWith("~") && roleSet,
          },
        ]
      : []),
    {
      id: "channels",
      title: "选择回复范围",
      description: "勾选机器人要回复的群和私聊。",
      target: `/plugins/${coreConfig.configPath}`,
      done: coreConfig.allowedChannels > 0,
    },
  ];
  return { complete: steps.every((step) => step.done), steps };
}

function collectAdapters(ctx: Host, presence?: QQPresence): PanelAdapter[] {
  const plugins = flattenPluginConfig(ctx.loader.config.plugins ?? {});
  const bots = Array.from(ctx.bots);
  return (
    Object.entries(plugins)
      // The console provides the built-in web chat but is not an account adapter.
      .filter(([key]) => {
        const base = normalizePluginKey(key);
        return base.startsWith("adapter-") || (!!platformOfAdapter(base) && platformOfAdapter(base)!.id !== WEB_CHAT.platform);
      })
      .map(([rawKey, value]) => {
        const enabled = !rawKey.startsWith("~");
        const raw = rawKey.replace(/^~/, "");
        const base = normalizePluginKey(raw);
        const config = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
        // Registered platforms name their adapter plugin; other adapters follow `adapter-<platform>`.
        const platform = platformOfAdapter(base)?.id ?? base.slice("adapter-".length);
        const selfId = typeof config.selfId === "string" ? config.selfId : "";
        // WeChat names no account in its settings: its bot speaks for a daemon account and learns the wxid at login.
        const bot = selfId
          ? bots.find((candidate) => candidate.platform === platform && candidate.selfId === selfId)
          : bots.find((candidate) => candidate.platform === platform && daemonAccount(candidate.config) === daemonAccount(config));
        let state: PanelAdapter["state"] = "disabled";
        if (enabled) {
          state = platformOfAdapter(base)?.login === "wechat" || hasAdapterConnection(config) ? "configured" : "unconfigured";
          if (bot?.error) state = "error";
          else if (bot?.status === BOT_ONLINE) state = platformDefinition(platform)?.login === "napcat" && presence?.isOffline(selfId) ? "offline" : "online";
        }
        const avatar = bot?.user?.avatar;
        return {
          key: raw,
          name: platformLabel(platform),
          platform,
          enabled,
          state,
          configPath: instancePath(raw),
          error: bot?.error?.message,
          ...(typeof avatar === "string" && /^https?:\/\//.test(avatar) && avatar.length <= 2048 ? { avatar } : {}),
        };
      })
      .sort((left, right) => {
        return (
          platformOrder(left.platform) - platformOrder(right.platform) || Number(right.enabled) - Number(left.enabled) || left.name.localeCompare(right.name)
        );
      })
  );
}

/** Registered platforms first, in registry order. */
function platformOrder(platform: string): number {
  const index = PLATFORMS.findIndex((item) => item.id === platform);
  return index < 0 ? PLATFORMS.length : index;
}

/** The agent-wechat account a WeChat adapter speaks for (`bot` unless set). */
function daemonAccount(config: unknown): string | undefined {
  if (!config || typeof config !== "object") return undefined;
  const account = (config as { account?: unknown }).account;
  return typeof account === "string" && account ? account : "bot";
}

function hasAdapterConnection(config: Record<string, unknown>): boolean {
  return ["selfId", "token", "endpoint", "appId", "appSecret", "botToken", "secret"].some((key) => typeof config[key] === "string" && Boolean(config[key]));
}

function readCoreConfig(
  ctx: Host,
): PanelPayload["config"] & { chatModel: string | null; visionModel: string | null; imageInput: boolean; imageBudget: PanelPayload["model"]["imageBudget"] } {
  const plugins = flattenPluginConfig(ctx.loader.config.plugins ?? {});
  const coreEntry = Object.entries(plugins).find(([key]) => normalizePluginKey(key) === "yesimbot");
  const coreConfigKey = coreEntry?.[0] ? coreEntry[0].replace(/^~/, "") : "yesimbot";
  const raw = coreEntry?.[1] as Record<string, unknown> | undefined;
  const chatModel = typeof raw?.chatModel === "string" ? raw.chatModel : null;
  const visionModel = typeof raw?.visionModel === "string" ? raw.visionModel : null;
  const imageInput = raw?.imageInput !== false;
  const imageBudget = readImageBudget(raw?.imageInput, imageInput);
  const allowedChannels = Array.isArray(raw?.allowedChannels) ? raw.allowedChannels.length : 0;
  const basePath = typeof raw?.basePath === "string" ? raw.basePath : "data/yesimbot";

  return {
    chatModel,
    visionModel,
    imageInput,
    imageBudget,
    basePath,
    allowedChannels,
    configPath: instancePath(coreConfigKey),
  };
}

function readModelState(ctx: Host, config: ReturnType<typeof readCoreConfig>, issues: PanelIssue[]): PanelPayload["model"] {
  const model = ctx.yesimbot.model;
  const providers = model.listProviders();
  const registeredChatModels = model.listChatModels();
  const chatModels = registeredChatModels.length;
  const embeddingModels = model.listEmbeddingModels().length;
  const defaultChat = model.getDefaultChatModelId() ?? null;
  const defaultEmbedding = model.getDefaultEmbeddingModelId() ?? null;

  if (!config.chatModel) {
    issues.push({ level: "error", message: "未配置 chatModel" });
  } else if (!registeredChatModels.some((entry) => entry.fullId === config.chatModel)) {
    try {
      model.resolveChatModel(config.chatModel);
    } catch (cause) {
      issues.push({ level: "error", message: `chatModel 解析失败：${messageOf(cause)}` });
    }
  }
  if (config.visionModel && !registeredChatModels.some((entry) => entry.fullId === config.visionModel)) {
    try {
      model.resolveChatModel(config.visionModel);
    } catch (cause) {
      issues.push({ level: "warning", message: `visionModel 解析失败：${messageOf(cause)}` });
    }
  }
  if (!providers.length) {
    issues.push({ level: "warning", message: "没有已注册的模型 provider" });
  }

  return {
    chatModel: config.chatModel,
    visionModel: config.visionModel,
    defaultChat,
    defaultEmbedding,
    providers,
    chatModels,
    embeddingModels,
    imageInput: config.imageInput,
    imageBudget: config.imageBudget,
    describeImage: Boolean(config.visionModel),
  };
}

function collectPlugins(ctx: Host): PanelPlugin[] {
  const plugins = flattenPluginConfig(ctx.loader.config.plugins ?? {});
  const providerCounts = new Map<string, number>();
  for (const [key, value] of Object.entries(plugins)) {
    if (key.startsWith("~")) continue;
    const base = normalizePluginKey(key);
    for (const id of providerIdsFor(base, value) ?? []) {
      providerCounts.set(id, (providerCounts.get(id) ?? 0) + 1);
    }
  }
  const result = Object.entries(plugins)
    .filter(([key]) => {
      const base = normalizePluginKey(key);
      return base === "yesimbot" || (base.startsWith("yesimbot-") && base !== "yesimbot-world") || base.startsWith("@yesimbot/");
    })
    .map(([rawKey, value]) => toPanelPlugin(rawKey, value, ctx, providerCounts));

  const order = new Map(PLUGIN_ORDER.map((key, index) => [key, index]));
  return result.sort((left, right) => {
    const leftOrder = order.get(normalizePluginKey(left.key)) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(normalizePluginKey(right.key)) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.key.localeCompare(right.key);
  });
}

function providerIdsFor(key: string, value: unknown): string[] | undefined {
  if (key !== "yesimbot-model-provider") return undefined;
  const config = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (!Array.isArray(config.connections)) return [];
  return config.connections.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || entry.enabled === false) return [];
    return [typeof entry.id === "string" ? entry.id : typeof entry.type === "string" ? entry.type : "openai"];
  });
}

function toPanelPlugin(rawKey: string, _value: unknown, ctx: Host, providerCounts: ReadonlyMap<string, number>): PanelPlugin {
  const enabled = !rawKey.startsWith("~");
  const raw = enabled ? rawKey : rawKey.slice(1);
  const key = normalizePluginKey(raw);
  const value = _value && typeof _value === "object" ? (_value as Record<string, unknown>) : {};
  const label = typeof value["$label"] === "string" ? value["$label"] : (PLUGIN_LABELS[key] ?? key);
  const providerIds = providerIdsFor(key, value);
  let status: PanelPlugin["status"] = enabled ? "enabled" : "disabled";
  let detail = enabled ? "已启用" : "未启用";

  if (key === "yesimbot") {
    detail = "核心服务";
  } else if (providerIds !== undefined) {
    const duplicates = providerIds.filter((id) => (providerCounts.get(id) ?? 0) > 1);
    const registered = ctx.yesimbot.model.listProviders();
    const missing = providerIds.filter((id) => !registered.includes(id));
    if (!enabled) {
      status = "disabled";
    } else if (duplicates.length) {
      status = "attention";
      detail = `重复的 provider 标识：${[...new Set(duplicates)].join("、")}`;
    } else if (missing.length) {
      status = "attention";
      detail = `已启用但 provider 未注册：${missing.join("、")}`;
    } else {
      detail = providerIds.length ? `已注册：${providerIds.join("、")}` : "未启用任何模型连接";
    }
  }

  return { key: rawKey, label, enabled, status, detail, configPath: instancePath(raw) };
}

function instancePath(key: string): string {
  const raw = key.replace(/^~/, "");
  const index = raw.indexOf(":");
  return index < 0 ? raw : raw.slice(index + 1);
}

function normalizePluginKey(key: string): string {
  const bare = key.startsWith("~") ? key.slice(1) : key;
  const instanceIndex = bare.indexOf(":");
  return instanceIndex < 0 ? bare : bare.slice(0, instanceIndex);
}

function flattenPluginConfig(plugins: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plugins)) {
    if (key.startsWith("group:")) {
      if (!value || typeof value !== "object") continue;
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        if (childKey === "$collapsed" || childKey === "$label") continue;
        result[childKey] = childValue;
      }
      continue;
    }
    result[key] = value;
  }
  return result;
}

function readImageBudget(value: unknown, enabled: boolean): PanelPayload["model"]["imageBudget"] {
  if (!enabled) return null;
  if (!value || typeof value !== "object") {
    return { maxCount: 3, maxBytesPerImage: 5 * 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024 };
  }
  const config = value as { maxCount?: unknown; maxBytesPerImage?: unknown; maxTotalBytes?: unknown };
  return {
    maxCount: typeof config.maxCount === "number" ? config.maxCount : 3,
    maxBytesPerImage: typeof config.maxBytesPerImage === "number" ? config.maxBytesPerImage : 5 * 1024 * 1024,
    maxTotalBytes: typeof config.maxTotalBytes === "number" ? config.maxTotalBytes : 10 * 1024 * 1024,
  };
}

function messageOf(cause: unknown): string {
  return errorUserText(cause) ?? (cause instanceof Error ? cause.message : String(cause));
}

export type { PanelPayload, PanelPlugin, PanelAdapter, PanelIssue, PanelRecent, PanelOnboardingStep, PanelOnboarding } from "./shared/panel.js";
