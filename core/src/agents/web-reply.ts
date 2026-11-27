import type { AgentTool } from "@yesimbot/agent-runtime";
import { partsFromElements, textPart, type FilePart, type ImagePart, type Part } from "@yesimbot/contracts/parts";
import { z } from "zod/v4";

import type { WebChatAccount } from "../accounts.js";
import { parseMarkup } from "../messages/markup.js";
import { materializeOutputPart, RESOURCE_MAX_BYTES, resourceErrorCode, type ChannelResources } from "../resources/index.js";
import { toolActors } from "../tool-policy.js";
import type { ReplyDeliveryNotice, ReplySendFailureNotice } from "./reply.js";

/** Same bound as the chat-platform sender's `parts`. */
const MAX_WEB_MESSAGES = 13;
/** Clickable replies under the last message (user, 2026-11-18): a few short options. */
const MAX_CHOICES = 4;
const MAX_CHOICE_CHARS = 40;

type WebSendInput = z.infer<ReturnType<typeof webSendSchema>>;

/**
 * The history receipt shape (`messageIds`/`count`, or `sent`/`failedAt`) that context regions and blocks read:
 * the sent messages are exactly `input.messages` up to `count` or `failedAt`, because web text is never rewritten.
 */
type WebSendOutput =
  | { ok: true; messageIds: string[]; count: number }
  | { ok: false; error: { name: string; message: string }; sent: string[]; failedAt: number };

export interface WebReplyToolsOptions {
  readonly bot: Pick<WebChatAccount, "createMessage">;
  readonly channelId: string;
  /** Where a message that is one `<file>`/`<img>` reads its bytes (user, 2026-11-17: the web bot sends any kind of file). */
  readonly resources?: ChannelResources;
  readonly innerThought: boolean;
  /** Current-turn admission, rechecked before every message: silent, superseded, stale or stopped turns never send. */
  readonly allowed: (turnId: string) => boolean;
  readonly onDelivered: (notice: ReplyDeliveryNotice) => void;
  readonly onFailed?: (notice: ReplySendFailureNotice) => void;
}

export interface WebReplyToolSet {
  readonly tools: AgentTool[];
  /** Resolves once every send already queued has settled. */
  settle(): Promise<void>;
  /** Later messages of this turn are refused; one already handed to the transport still settles. */
  abortTurn(turnId: string): void;
  finishTurn(turnId: string): Promise<void>;
  invalidate(): void;
}

/**
 * Web chat's `send_message`. Each item of `messages` is one literal Markdown bubble, sent in order; only what this
 * tool sends is shown to the user, so model text stays internal exactly as on other platforms. Unlike the
 * chat-platform sender there is no pacing, element parsing, sticker or other channel. Like it, sending never ends
 * the turn (send/finish separation, confirmed 2026-11-05): the model checks the result and calls `finish`.
 */
export function createWebReplyTools(options: WebReplyToolsOptions): WebReplyToolSet {
  let tail: Promise<unknown> = Promise.resolve();
  let retired = false;
  const closedTurns = new Set<string>();
  const close = (turnId: string) => {
    closedTurns.add(turnId);
    if (closedTurns.size > 64) closedTurns.delete(closedTurns.values().next().value!);
  };
  const allowed = (turnId: string, signal?: AbortSignal): boolean => {
    try {
      return !retired && !closedTurns.has(turnId) && !signal?.aborted && options.allowed(turnId);
    } catch {
      return false;
    }
  };
  const send = async (
    turnId: string,
    messages: readonly string[],
    signal?: AbortSignal,
    actorIds?: readonly string[],
    choices: readonly string[] = [],
  ): Promise<WebSendOutput> => {
    const sent: string[] = [];
    const stop = (name: string, message: string): WebSendOutput => {
      if (sent.length) {
        try {
          options.onFailed?.({ channelId: options.channelId, turnId, failedAt: sent.length, total: messages.length, error: { name, message } });
        } catch {
          /* Observer only. */
        }
      }
      return { ok: false, error: { name, message }, sent, failedAt: sent.length };
    };
    for (const [index, text] of messages.entries()) {
      if (!allowed(turnId, signal)) return stop("DeliveryNotAllowed", sent.length ? "运行环境已变化，其余消息没有发送" : "本轮不能发送消息，没有发出任何内容");
      // A message that is exactly one <file>/<img> is that file; everything else stays literal Markdown.
      let content: Part = textPart(text);
      const resource = singleResource(text);
      if (resource) {
        const read = await readResource(resource, signal, actorIds);
        if (typeof read === "string") {
          if (!sent.length) {
            try {
              options.onFailed?.({
                channelId: options.channelId,
                turnId,
                failedAt: 0,
                total: messages.length,
                error: { name: "ResourceReadFailed", message: read },
              });
            } catch {
              /* Observer only. */
            }
            return { ok: false, error: { name: "ResourceReadFailed", message: `${read}；没有发出任何内容` }, sent, failedAt: 0 };
          }
          return stop("ResourceReadFailed", `${read}；这一条和之后的都没有发送，已发出的不要重发`);
        }
        if (!allowed(turnId, signal))
          return stop("DeliveryNotAllowed", sent.length ? "运行环境已变化，其余消息没有发送" : "本轮不能发送消息，没有发出任何内容");
        content = read;
      }
      // The options ride on the last message, which the transport shows as buttons.
      const last = index === messages.length - 1 && choices.length > 0;
      let messageId: string | undefined;
      try {
        messageId = (await options.bot.createMessage(options.channelId, last ? [content, { type: "choices", options: [...choices] }] : [content]))[0]?.id;
      } catch {
        messageId = undefined;
      }
      if (!messageId) {
        if (!sent.length) {
          try {
            options.onFailed?.({
              channelId: options.channelId,
              turnId,
              failedAt: 0,
              total: messages.length,
              error: { name: "SendFailed", message: "网页消息没有送达" },
            });
          } catch {
            /* Observer only. */
          }
          return { ok: false, error: { name: "SendFailed", message: "网页消息没有送达；不要换别的工具重发同一内容" }, sent, failedAt: 0 };
        }
        return stop("SendFailed", "这一条没有送达，之后的也没有发送；已发出的不要重发");
      }
      sent.push(messageId);
      options.onDelivered({ turnId, channelId: options.channelId, messageId, text });
    }
    return { ok: true, messageIds: sent, count: sent.length };
  };
  /** The transport element, or why the file cannot be sent. */
  const readResource = async (part: ImagePart | FilePart, signal?: AbortSignal, actorIds?: readonly string[]): Promise<Part | string> => {
    if (!options.resources) return "这里不能发送文件";
    try {
      const opened = await options.resources.openStrict(String(part.src), signal, actorIds);
      return materializeOutputPart(part, opened) ?? "<img> 指向的不是图片，要发其他文件请用 <file>";
    } catch (cause) {
      return resourceFailure(resourceErrorCode(cause) ?? "resource_read_failed");
    }
  };
  const tool: AgentTool<WebSendInput, WebSendOutput> = {
    name: "send_message",
    terminal: false,
    description: webSendDescription(options.innerThought),
    inputSchema: webSendSchema(options.innerThought),
    execute: async (input, execution) => {
      const value = input as unknown as Record<string, unknown>;
      const keys = ["messages", "choices", ...(options.innerThought ? ["inner_thought"] : [])];
      const messages = value?.messages;
      const choices = value?.choices;
      if (
        typeof value !== "object" ||
        value === null ||
        !Object.keys(value).every((key) => keys.includes(key)) ||
        !Array.isArray(messages) ||
        messages.length < 1 ||
        messages.length > MAX_WEB_MESSAGES ||
        !messages.every((text): text is string => typeof text === "string" && text.trim().length > 0) ||
        (value.inner_thought !== undefined && typeof value.inner_thought !== "string") ||
        (choices !== undefined &&
          (!Array.isArray(choices) ||
            choices.length < 2 ||
            choices.length > MAX_CHOICES ||
            new Set(choices.map((choice) => String(choice).trim())).size !== choices.length ||
            !choices.every((choice): choice is string => typeof choice === "string" && !!choice.trim() && [...choice].length <= MAX_CHOICE_CHARS)))
      )
        return {
          ok: false,
          error: {
            name: "InvalidInput",
            message: `messages 必须是 1–${MAX_WEB_MESSAGES} 条非空文本；choices 若提供须是 2–${MAX_CHOICES} 个不重复的短选项（每项不超过 ${MAX_CHOICE_CHARS} 字）；没有发出任何内容`,
          },
          sent: [],
          failedAt: 0,
        };
      const actorIds = toolActors(execution.messages, "").map((actor) => actor.userId);
      const offered = Array.isArray(choices) ? choices.map((choice) => String(choice).trim()) : [];
      const run = tail.then(() => send(execution.turnId, [...messages], execution.abortSignal, actorIds, offered));
      tail = run.catch(() => undefined);
      return await run;
    },
  };
  return {
    tools: [tool as unknown as AgentTool],
    settle: async () => {
      await tail;
    },
    abortTurn: close,
    finishTurn: async (turnId) => {
      close(turnId);
      await tail;
    },
    invalidate: () => {
      retired = true;
    },
  };
}

/** A whole message that is one `<file src>` or `<img src>` element (surrounding whitespace allowed). */
export function singleResource(text: string): ImagePart | FilePart | undefined {
  const trimmed = text.trim();
  if (!/^<(img|file)\b/i.test(trimmed) || !/\/?>$/.test(trimmed)) return undefined;
  const elements = parseMarkup(trimmed).filter((element) => element.type !== "text" || String(element.attrs.content ?? "").trim());
  const element = elements.length === 1 ? elements[0] : undefined;
  if (!element || (element.type !== "img" && element.type !== "file") || typeof element.attrs.src !== "string" || element.children.length) return undefined;
  const [part] = partsFromElements([element], { sources: true });
  return part?.type === "image" || part?.type === "file" ? part : undefined;
}

function resourceFailure(code: string): string {
  const reasons: Record<string, string> = {
    resource_uri_invalid: "文件地址格式不对",
    resource_not_found: "找不到这个文件",
    resource_too_large: `文件超过 ${RESOURCE_MAX_BYTES / 1024 / 1024} MB`,
    resource_unavailable: "现在读不到这个位置（电脑可能不在线）",
    resource_delivery_restricted: "这个文件不能发送",
    resource_timeout: "读取文件超时",
  };
  return reasons[code] ?? "读取文件失败";
}

function webSendDescription(innerThought: boolean): string {
  return `把消息发到当前网页对话。用户只看得到本工具发出的内容；普通正文不会显示。
messages 按顺序发送，每一项显示为一条消息，内容是 Markdown（段落、列表、代码块、表格都可以），原样显示，不用转义。每条是一个有意义的交流单元：短而完整的回应用一条；包含独立回答和必要补充时，按交流意图分成几条，通常两三条足够，无须凑条数。不按字数、句号或空行机械拆分；完整的代码块、表格、命令和精确引用放在同一条里。
发文件或图片：单独占一项，整项只写一个元素，如 <file src="workspace:///报告.pdf"/> 或 <img src="workspace:///图.png"/>，用资源的真实 URI。任何类型的文件都可以，单个不超过 ${RESOURCE_MAX_BYTES / 1024 / 1024} MB；文件名默认用原文件名，可加 title="名称.后缀" 另起。用户会看到预览或下载。Markdown 正文里的元素不会被解析；不支持 <at>、表情包或发往其他频道。
需要对方在几个明确的选项里挑一个时（例如「替我发 / 先等等」），可以加 choices（2–${MAX_CHOICES} 个短选项），它们显示在最后一条消息下面，对方点哪个就当作他回复了那一项；开放式的问题不用它，也不要每条都加。
本工具只发送消息，不结束本轮：需要先简短确认再工作时，可以先发确认，再继续调用工具；确认任务完成且消息发送结果符合预期后，单独调用 finish 结束本轮。不要在同一步并行调用 send_message 和 finish。
${innerThought ? "inner_thought 是私有行为判断，不是角色台词，不会发送。\n" : ""}返回 ok 和 messageIds。失败时 sent 是已显示的消息；不要重发已显示的内容，也不要换别的工具重发。`;
}

function webSendSchema(innerThought: boolean) {
  const send = z.strictObject({
    messages: z.array(z.string().min(1)).min(1).max(MAX_WEB_MESSAGES).describe("按顺序发送的消息，每项是一条完整的 Markdown 消息"),
    choices: z
      .array(z.string().min(1).max(MAX_CHOICE_CHARS))
      .min(2)
      .max(MAX_CHOICES)
      .describe("可选：显示在最后一条消息下的可点选项，用户点哪个就把那项作为回复发来")
      .optional(),
  });
  return innerThought ? send.extend({ inner_thought: z.string().describe("私有行为判断，不会发送").optional() }) : send;
}
