import type { AgentPlugin } from "@yesimbot/agent-runtime";
import { errorFields, logger, type Clock, type Logger } from "@yesimbot/foundation";
import { RESOURCE_ERRORS, protectPluginTools, resourceError, toolAllowed } from "koishi-plugin-yesimbot/kernel";
import type { CoreService } from "koishi-plugin-yesimbot/kernel";
import type {
  ChannelContext,
  ChannelPlugin,
  ChannelResources,
  ChatAccount,
  ContextRegionReviewer,
  ResourceOpenOptions,
  ResourceOpenResult,
} from "koishi-plugin-yesimbot/kernel";

import { MEMORY_SCHEME_PROMPT, parseAttachmentUri } from "./attachment-uri.js";
import type { Config } from "./config.js";
import { CONSOLIDATION_WINDOW_MS, runConsolidation } from "./consolidator.js";
import { MemoryLibrary } from "./library.js";
import { mergeRequests, runMaintenance } from "./maintainer.js";
import { createChannelTools, type ChannelToolOptions } from "./plugin.js";
import { prepareRegionReview } from "./review.js";
import { MAX_MESSAGES_PER_BATCH, MemoryScheduler, type MemoryTimer } from "./scheduler.js";
import { runSearch } from "./searcher.js";
import { createEmbeddingIndexer } from "./semantic.js";
import { EvidenceStore } from "./store/evidence.js";
import { MemoryStore } from "./store/memory.js";
import { PendingStore } from "./store/pending.js";
import type { MemoryTable } from "./store/table.js";

const CHANNEL_MEMORY_PROMPT = `## 长期记忆

长期记忆由你自己记：记不记、记什么都由你判断，写进去的就是最终结果，没有别的模型替你复查或改写。记忆是对人的长期理解和踩过的坑，不是聊天记录、操作日志或工作台账：只保留有长期价值、可由当前证据支持且不涉及敏感凭据的内容。

- **recall**：当前上下文里缺少跨轮背景（这个人以前说过的事、以前的约定、踩过的坑）时先用它，必要时再启用语义召回；需要交叉验证多条记忆或回答复杂关系问题时设 report=true 让记忆代理出报告，简单事实直接查。当前消息已经足够回应时不额外检索；核实外部事实用搜索等信息来源，记忆不是外部事实的依据。
- **remember**：写入和修改都用它。action=create：不必等对方要求，听到对这个人长期有用的理解就记：身份、在乎的人和事、偏好、做过的决定、许下的承诺、改变处境的结果，或者踩过的坑（行不通的做法、原因和后来有效的做法）。对方明确要你记住时也用它。工具返回成功才算记住，之后才能说「记住了」。要连图片或文件一起记住时（某人的照片、你的立绘、对方要你留着的文档），把消息里的 asset:// 地址放进 attachments；recall 会给出 memory:// 地址，在看得到这条记忆的地方都能读、当参考图或发出去。工作进度、排查过程、工具或系统一时的状态、待办、配置和资料（写进工作区或电脑上的文件）、临时请求、纯情绪/玩笑、已记住的内容、密码、token 和验证码都不记。
  content 写成以后单独看也能懂的一句话：一次只记一件事；写明是谁（名字或 ID，不写「他」「用户」）、什么事、什么时候（具体日期，不写「昨天」「刚才」）；本人说的直接写，别人转述的写明「据某某说」；踩过的坑写成「做什么时会怎样，改用什么」。只记对方说的和实际发生的，不把工具结果、网页内容或你自己的推测当成对方的事实。
- **remember 的 action=update**：已有记忆变了（改期、取消、完成、换了工作）或记错了，就改那一条，不另写一条互相矛盾的；不再成立的设 forget=true。不确定记没记过时先 recall。

较早的对话被整理成摘要之前，系统会让你把那段原文再看一遍补记；摘要本身不当作记忆证据。已验证主人的私人入口共享主人记忆；群聊只能看到原会话与明确公开的通用知识。主人在私聊里明确要你公开的，可以记成 scope=shared，群聊和其他平台都看得到；别人的私聊不行。共享正文不公开原始证据。

记忆内容和回复都要区分证据、推测与不确定性；具体字段、范围和限制以工具 schema 为准。`;

/** The part of Core's `ctx.yesimbot` the memorizer uses. */
export type MemorizerHost = Pick<CoreService, "agent" | "identity" | "resource" | "conversation" | "model" | "config">;

export interface MemorizerServiceDeps {
  readonly host: MemorizerHost;
  readonly table: MemoryTable;
  /** Directory of the evidence files, the kept attachments and the legacy pending queue. */
  readonly root: string;
  readonly clock: Clock;
  readonly timer: MemoryTimer;
  readonly interval: MemoryTimer;
  /** Whether this direct chat is the verified owner's: the transport authenticates it, never a name or ID. */
  readonly isOwner: (context: ChannelContext) => boolean;
  readonly logger?: Logger;
}

/**
 * The memorizer, the memory store, the evidence files, the `memory://` reader, the per-channel
 * tools and the daily upkeep. The extension supplies the table, timers, the clock and the owner check.
 */
export class MemorizerService implements ChannelPlugin {
  public readonly id = "yesimbot-memorizer";
  /** The owner management API the glue publishes as `yesimbotMemory`. */
  public readonly library: MemoryLibrary;

  private readonly store: MemoryStore;
  private readonly evidence: EvidenceStore;
  private readonly pending: PendingStore;
  private readonly scheduler: MemoryScheduler;
  private readonly log: Logger;
  /** Which conversation a ChannelResources belongs to, for reading attachments (as the workspace plugin does). */
  private readonly bindings = new WeakMap<
    ChannelResources,
    { context: ChannelContext; conversation: Awaited<ReturnType<MemorizerHost["identity"]["conversation"]>> }
  >();
  private disposeAgentPlugin?: () => void;
  private disposeReader?: () => void;
  private started = false;

  public constructor(
    private readonly deps: MemorizerServiceDeps,
    private readonly config: Config,
  ) {
    const { host, clock } = deps;
    this.log = deps.logger ?? logger("yesimbot.memorizer");
    // The vector model is chosen on the model page.
    const embeddingModelId = host.config.embeddingModel?.trim() || undefined;
    const indexer = embeddingModelId
      ? createEmbeddingIndexer({
          modelId: embeddingModelId,
          resolve: () => host.model.resolveEmbedding(embeddingModelId),
          warn: (event, fields) => this.log.warn(event, fields),
        })
      : undefined;
    this.store = new MemoryStore(deps.table, {
      clock,
      tenantId: () => host.identity.tenantId(),
      isOwner: deps.isOwner,
      indexer,
    });
    this.evidence = new EvidenceStore(deps.root);
    this.library = new MemoryLibrary({ store: this.store, evidence: this.evidence });
    // Nothing enqueues any more: the queue only drains requests left by the previous version, then stays empty.
    this.pending = new PendingStore(deps.root);
    this.scheduler = new MemoryScheduler(
      this.pending,
      async (channel, batch) => {
        const messages = await host.conversation.read(channel, {
          messageIds: [...new Set(batch.flatMap((item) => item.sources))],
          before: 10,
          after: 10,
          limit: MAX_MESSAGES_PER_BATCH,
        });
        await runMaintenance({
          model: host.model.resolveAuxiliaryModel("memory-summary", channel).model,
          context: channel,
          messages,
          store: this.store,
          evidence: this.evidence,
          request: mergeRequests(batch.map((item) => item.content)),
          allowShared: batch.some((item) => item.scope === "shared"),
        });
      },
      { clock, timer: deps.timer, interval: deps.interval, logger: this.log },
      () =>
        this.store
          .sweep(clock.now(), (id) => this.evidence.remove(id))
          .then(async () => {
            const indexed = await this.store.reindex();
            if (indexed > 0) this.log.info("memorizer.embedding_reindexed", { indexed, remaining: await this.store.missingEmbeddings() });
            await this.consolidate();
          }),
    );
  }

  public async start(): Promise<void> {
    if (this.started) return;
    await this.pending.init();
    await this.scheduler.start();
    this.disposeReader = this.deps.host.resource.use({
      scheme: "memory",
      prompt: MEMORY_SCHEME_PROMPT,
      setup: (resources, uri, options) => this.openAttachment(resources, uri, options),
    });
    this.disposeAgentPlugin = this.deps.host.agent.use(this);
    this.started = true;
  }

  public async setup(context: ChannelContext, bot: ChatAccount): Promise<AgentPlugin> {
    const { host, clock } = this.deps;
    context = { ...context, selfId: context.selfId ?? bot.selfId };
    const conversation = await host.identity.conversation(context);
    const resources = await host.resource.get(context);
    this.bindings.set(resources, { context, conversation });
    const options: Omit<ChannelToolOptions, "participants"> = {
      clock,
      evidenceCount: (id) => this.evidence.count(id),
      readConversation: host.conversation.read,
      openResource: async (uri) => {
        const opened = await resources.openStrict(uri);
        return { ...opened, mediaType: resources.detectImageMediaType(opened.bytes) ?? opened.mediaType };
      },
      mayPublish: async () => (await this.store.isOwnerConversation(context)) || this.adminChat(context),
      search: (value, execution) =>
        runSearch({
          clock,
          model: host.model.resolveAuxiliaryModel("utility", context).model,
          context,
          execution,
          store: this.store,
          evidence: this.evidence,
          query: value.query,
          scope: value.scope,
          limit: value.limit,
        }),
    };
    const plugin: AgentPlugin & ContextRegionReviewer = {
      name: "memory-agent",
      appendSystemPrompt: () => CHANNEL_MEMORY_PROMPT,
      tools: () => createChannelTools(context, this.store, this.evidence, options),
      // Core runs the review only with tools this conversation's request actually offered.
      beforeContextRegion: (range) =>
        toolAllowed(conversation, { name: "remember", pluginId: this.id, contexts: ["direct", "group"] })
          ? prepareRegionReview({ ...options, context, store: this.store, evidence: this.evidence }, range)
          : undefined,
    };
    return protectPluginTools(plugin, conversation, "yesimbot-memorizer");
  }

  public async stop(): Promise<void> {
    this.started = false;
    this.disposeAgentPlugin?.();
    this.disposeAgentPlugin = undefined;
    this.disposeReader?.();
    this.disposeReader = undefined;
    await this.scheduler.stop();
  }

  /**
   * The direct chat of an account the account holder registered as admin on this platform (Core `admins`, the same
   * accounts sensitive tools obey). It may publish shared memories (user, 2026-11-24: 「只有主人私聊可以」, asked from QQ),
   * but it does not see owner-private memories: those still need the transport's verified owner.
   */
  private adminChat(context: ChannelContext): boolean {
    if (context.type !== "direct" || !context.userId) return false;
    return (this.deps.host.config.admins ?? []).some((admin) => admin?.platform === context.platform && admin.userId?.trim() === context.userId);
  }

  /** A memory's picture or file, only where that memory is visible and memory tools are allowed. */
  private async openAttachment(resources: ChannelResources, uri: URL, options: ResourceOpenOptions): Promise<ResourceOpenResult> {
    const binding = this.bindings.get(resources);
    if (!binding || !toolAllowed(binding.conversation, { name: "recall", pluginId: this.id, contexts: ["direct", "group"] }))
      throw resourceError(RESOURCE_ERRORS.resource_unavailable);
    const target = parseAttachmentUri(uri);
    if (!target) throw resourceError(RESOURCE_ERRORS.resource_uri_invalid);
    const { context } = binding;
    // Who takes part in this turn; a scheduled direct turn has no sender, and its person is the chat's.
    const userIds = options.actorIds ?? (context.type === "direct" ? [context.userId] : []);
    if (!(await this.store.visibleMemory(target.memoryId, context, userIds))) throw resourceError(RESOURCE_ERRORS.resource_not_found);
    const file = await this.evidence.openAttachment(target.memoryId, target.index, options.maxBytes);
    if (!file) throw resourceError(RESOURCE_ERRORS.resource_not_found);
    return file;
  }

  /** Daily: merge or retire near-duplicates among new memories. Failures only log; the next day retries. */
  private async consolidate(): Promise<void> {
    const { host, clock } = this.deps;
    try {
      const result = await runConsolidation({
        clock,
        model: host.model.resolveAuxiliaryModel("memory-summary").model,
        store: this.store,
        evidence: this.evidence,
        since: clock.now() - CONSOLIDATION_WINDOW_MS,
      });
      if (result.groups > 0) this.log.info("memorizer.consolidated", result);
    } catch (cause) {
      this.log.warn("memorizer.consolidation_failed", { ...errorFields(cause) });
    }
  }
}
