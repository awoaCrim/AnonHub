import { EphemeralImageProjectionStore, type AgentPlugin, type AgentTool } from "@yesimbot/agent-runtime";
import { AppError, logger, type Clock } from "@yesimbot/foundation";
import { protectPluginTools } from "koishi-plugin-yesimbot/kernel";
import type { ChannelContext, ChannelPluginSetupContext, ChannelResources, ChatAccount } from "koishi-plugin-yesimbot/kernel";

import { createSearXNGBackend } from "./backends/searxng.js";
import { createTavilyBackend } from "./backends/tavily.js";
import type { Config, SearXNGConfig, TavilyConfig } from "./config.js";
import { SEARCH_ERRORS } from "./errors.js";
import { createImportImageReferenceTool } from "./reference-import.js";
import type { SearchBackend, SearchRuntimeConfig } from "./types.js";
import { REQUEST_TIMEOUT_MS } from "./utils.js";

export const SEARCH_SERVICE_ID = "yesimbot-search-service";

const DEFAULT_PROVIDER = "tavily";

const log = logger("yesimbot.search-service");

/** What the service takes from Core: the channel's resources and the conversation identity its tool policy is checked against. */
export interface SearchHost {
  resources(scope: ChannelContext): Promise<Pick<ChannelResources, "artifacts" | "maxBytes">>;
  conversation(scope: ChannelContext): Promise<Parameters<typeof protectPluginTools>[1]>;
}

/** Search tools for one configured backend, and the per-channel plugin that offers them with the reference import. */
export class SearchService {
  private backend?: SearchBackend;
  private searchTools: AgentTool[] = [];

  constructor(
    private readonly config: Config,
    private readonly host: SearchHost,
    private readonly clock: Clock,
  ) {}

  public start(): void {
    const provider = this.config.provider ?? DEFAULT_PROVIDER;
    const runtime: SearchRuntimeConfig = { blacklist: this.config.blacklist ?? [] };

    switch (provider) {
      case "tavily":
        this.backend = createTavilyBackend(this.config.tavily as TavilyConfig | undefined, runtime, this.clock);
        break;
      case "searxng":
        this.backend = createSearXNGBackend(this.config.searxng as SearXNGConfig | undefined, runtime);
        break;
      default:
        throw new AppError(SEARCH_ERRORS.search_config_invalid, { effect: "none", detail: `unsupported search provider: ${String(provider)}` });
    }

    const backend = this.backend;
    const searchTools = [backend.createSearchTool(), backend.createImageSearchTool()];
    const scrapeTool = backend.createScrapeTool?.();
    if (scrapeTool) {
      searchTools.push(scrapeTool);
    }

    this.searchTools = searchTools;
    log.info("service.started", { provider });
  }

  public async setup(scope: ChannelContext, account: ChatAccount, runtime?: ChannelPluginSetupContext): Promise<AgentPlugin | null> {
    if (!this.backend) return null;
    const resources = await this.host.resources(scope);
    const imageProjection = runtime?.imageProjection ?? new EphemeralImageProjectionStore();
    const tools = [
      ...this.searchTools,
      createImportImageReferenceTool({ resources, imageProjection, imagePreview: runtime?.imagePreview, timeoutMs: REQUEST_TIMEOUT_MS }),
    ];
    return protectPluginTools(
      {
        name: "search-service",
        tools,
        appendSystemPrompt: () => formatSearchPrompt(tools.map((tool) => tool.name)),
        onTurnFinish: (_result, context) => imageProjection.clearTurn(context.turnId),
        stop: () => imageProjection.clearAll(),
      } satisfies AgentPlugin,
      await this.host.conversation({ ...scope, selfId: scope.selfId ?? account.selfId }),
      SEARCH_SERVICE_ID,
    );
  }

  public stop(): void {
    this.searchTools = [];
    this.backend = undefined;
  }
}

function formatSearchPrompt(toolNames: readonly string[]): string {
  return [
    "## Web Search",
    `可用工具：${toolNames.map((name) => "`" + name + "`").join("、")}。需要外部信息时使用；结果只是线索，不是自动成立的事实，也不要把未经证实的假设写进查询词再用结果反证它。${toolNames.includes("read_webpage") ? "需要核对完整页面时用 read_webpage 读取候选 URL。" : ""}`,
    "给具体人物、角色或商品找参考图的流程见 import_image_reference 的说明。",
  ].join("\n");
}
