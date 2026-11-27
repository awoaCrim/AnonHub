import { setTimeout as wait } from "node:timers/promises";

import { EphemeralImageProjectionStore, EphemeralVideoProjectionStore, type AgentTool } from "@yesimbot/agent-runtime";
import type { Part } from "@yesimbot/contracts/parts";
import { AppError, detectImageType, toToolResult, type ToolFailure } from "@yesimbot/foundation";
import type { LanguageModel } from "ai";
import { z } from "zod/v4";

import type { PacingConfig } from "../config.js";
import { CONVERSATION_ERRORS, conversationError } from "../conversations/errors.js";
import { firstFrameToPng, isStillConvertible } from "../resources/image-transcode.js";
import {
  detectVideoMediaType,
  RESOURCE_MAX_BYTES,
  resourceErrorCode,
  VIDEO_MAX_BYTES,
  videoCompressionErrorCode,
  VIDEO_SOURCE_MAX_BYTES,
  type ChannelResources,
} from "../resources/index.js";
import { fetchRemoteImage } from "../resources/remote-image.js";
import { prepareVideoForModel } from "../resources/video-compression.js";
import {
  contextBlockId,
  contextBlocksInput,
  contextLoadInput,
  type ContextWorkspace,
  type ContextBlocksInput,
  type ContextLoadInput,
} from "../runtimes/context-workspace.js";
import { RUNTIME_ERRORS } from "../runtimes/errors.js";
import { toolActors } from "../tool-policy.js";
import { describeImageBytes } from "./image-preview.js";

/** Failures the ctx tools report as themselves; anything else is `context_read_failed`. */
const CONTEXT_FAILURE_CODES: ReadonlySet<string> = new Set<string>([
  ...Object.values(CONVERSATION_ERRORS),
  RUNTIME_ERRORS.context_budget_invalid,
  RUNTIME_ERRORS.context_budget_exceeded,
  RUNTIME_ERRORS.context_budget_media_unsupported,
]);

const READ_MAX_TEXT_CHARS = 30_000;

/** How long a WebP or GIF may take to become a PNG still for a model that refuses it. */
const STILL_TIMEOUT_MS = 10_000;

/** A picture by web address; anything else is a resource URI. */
const WEB_ADDRESS = /^https?:\/\//i;

/** What a failed read of a web address tells the model, so it neither retries blindly nor guesses the picture. */
const WEB_READ_FAILURES: Readonly<Record<string, string>> = {
  resource_uri_invalid: "只能读取公开的 https 图片网址：默认端口、不带账号密码；内网和本机地址不能读取。",
  resource_not_image: "这个网址返回的不是 PNG、JPEG、GIF 或 WebP 图片。",
  resource_too_large: "图片超过 5 MiB，没有读取。",
  resource_unavailable: "图片没有下载下来：网址打不开、返回了错误或跳转太多。不要根据网址猜测画面。",
  resource_timeout: "下载超时，图片没有读取。",
};

const resourceReadInput = z.object({ uri: z.string().describe("要读取的资源 URI") });

const describeImageInput = z.object({
  uri: z.string().describe("要描述的图片资源 URI，形如 asset://<32位十六进制id>"),
  question: z.string().describe("要从图片中获取的信息"),
});

export type ReadImageMode = "native" | "vision" | "unavailable";

/** Native video admission outcome reported to the model for one `read` call. */
export type VideoReadMode = "native" | "unavailable";

export type ResourceReadResult = {
  uri: string;
  filename?: string;
  mediaType?: string;
  text?: string;
  imageMode?: ReadImageMode;
  videoMode?: VideoReadMode;
  videoCompressed?: boolean;
  sourceBytes?: number;
  error?: string;
};

type DescribeImageInput = z.infer<typeof describeImageInput>;

type DescribeImageOutput = { text: string } | { error: string };

/** Execution context fields the native video branch needs; the rest stays in the AI SDK type. */
type ReadExecution = {
  readonly toolCallId: string;
  readonly turnId: string;
  readonly abortSignal?: AbortSignal;
};

export interface ReadImagePolicy {
  readonly mode: ReadImageMode;
  readonly visionModel?: LanguageModel;
  /** Optional route-specific allowlist for native image tool-result media. */
  readonly nativeMediaTypes?: readonly string[];
}

export interface ReadVideoPolicy {
  readonly mode: VideoReadMode;
  /** Core owns a synchronous per-turn budget, independent of cache TTL and call-id reuse. */
  readonly reserve: (turnId: string, toolCallId: string) => boolean;
  /** Rolls back a reservation when no payload could be staged. */
  readonly release?: (turnId: string, toolCallId: string) => void;
}

/** Optional additive native-video wiring; absent keeps every existing image/boolean behavior. */
export interface ReadVideoOptions {
  readonly policy?: ReadVideoPolicy;
  readonly projection?: EphemeralVideoProjectionStore;
}

/** Facts about one delivered platform message, reported so the owner can announce it. */
export interface DeliveredNotice {
  readonly channelId: string;
  readonly messageId: string;
  readonly turnId: string;
  readonly text: string;
}

/** Facts about an aborted send. The model learns from the tool result; this is for operators. */
export interface SendFailedNotice {
  readonly channelId: string;
  readonly turnId: string;
  readonly failedAt: number;
  readonly total: number;
  readonly error: { readonly name: string; readonly message: string };
}

export function createReadTool(
  resources: ChannelResources,
  policyInput: ReadImagePolicy | boolean,
  imageProjection = new EphemeralImageProjectionStore(),
  videoOptions: ReadVideoOptions = {},
): AgentTool<{ uri: string }, ResourceReadResult> {
  const policy: ReadImagePolicy = typeof policyInput === "boolean" ? { mode: policyInput && resources.imageInput ? "native" : "unavailable" } : policyInput;
  const videoPolicy = videoOptions.policy;
  const videoProjection = videoOptions.projection;
  const imageOwners = new WeakMap<ResourceReadResult, object>();
  // Owner tags bind the original execution result to its current projection without retaining
  // bytes in this WeakMap or serializing a private live-generation field in the receipt.
  const videoOwners = new WeakMap<ResourceReadResult, object>();

  /**
   * One successful native video read per turn. The synchronous reservation happens before any
   * projection work, so repeated call ids, retries or a stale TTL can never grant a second payload.
   */
  const readVideo = async (uri: string, opened: { bytes: Uint8Array; mediaType?: string }, execution: ReadExecution): Promise<ResourceReadResult> => {
    const abortSignal = execution.abortSignal;
    if (videoPolicy?.mode !== "native" || !resources.videoInput || !videoProjection) {
      return { uri, mediaType: opened.mediaType, videoMode: "unavailable", error: "video_input_unavailable", text: "模型没有看到视频内容。" };
    }
    if (opened.bytes.byteLength > VIDEO_SOURCE_MAX_BYTES) {
      return { uri, mediaType: opened.mediaType, videoMode: "unavailable", error: "resource_too_large", text: "模型没有看到视频内容。" };
    }
    if (abortSignal?.aborted) {
      return { uri, mediaType: opened.mediaType, videoMode: "unavailable", error: "resource_read_aborted", text: "模型没有看到视频内容。" };
    }
    if (!videoPolicy.reserve(execution.turnId, execution.toolCallId)) {
      return {
        uri,
        mediaType: opened.mediaType,
        videoMode: "unavailable",
        error: "video_turn_limit",
        text: "本回合已经成功读取过一个视频；本轮不会再次提供视频内容。",
      };
    }
    let bytes: Uint8Array;
    try {
      bytes = await prepareVideoForModel(opened.bytes, { signal: abortSignal });
    } catch (cause) {
      videoPolicy.release?.(execution.turnId, execution.toolCallId);
      return {
        uri,
        videoMode: "unavailable",
        error: videoCompressionErrorCode(cause) ?? "video_compression_failed",
        text: "视频未能准备完成，模型没有看到视频内容。",
      };
    }
    const owner = {};
    if (
      !videoProjection.stage({
        toolCallId: execution.toolCallId,
        turnId: execution.turnId,
        bytes,
        mediaType: "video/mp4",
        owner,
        ...(abortSignal === undefined ? {} : { signal: abortSignal }),
      })
    ) {
      videoPolicy.release?.(execution.turnId, execution.toolCallId);
      return {
        uri,
        videoMode: "unavailable",
        error: abortSignal?.aborted ? "resource_read_aborted" : "video_projection_unavailable",
        text: "模型没有看到视频内容。",
      };
    }
    const result: ResourceReadResult = {
      uri,
      mediaType: "video/mp4",
      text:
        opened.bytes.byteLength > VIDEO_MAX_BYTES
          ? `[视频资源，压缩版，video/mp4，${formatBytes(bytes.byteLength)}；原件 ${formatBytes(opened.bytes.byteLength)}，画质或音质可能降低]`
          : `[视频资源，video/mp4，${formatBytes(bytes.byteLength)}]`,
      videoMode: "native",
      ...(opened.bytes.byteLength > VIDEO_MAX_BYTES ? { videoCompressed: true, sourceBytes: opened.bytes.byteLength } : {}),
    };
    videoOwners.set(result, owner);
    return result;
  };
  // Pictures by web address are offered only where a picture can be seen; there is nothing to download otherwise.
  const imagesVisible = (policy.mode === "native" && resources.imageInput) || (policy.mode === "vision" && policy.visionModel !== undefined);
  const lines = [
    "读取资源内容。仅在确实需要内容时读取精确 URI，不要猜测或拼造 URI。",
    `URI 形如 scheme://authority[/path]，不能包含 ?、#、%，也不能有 . 或 .. 路径段${imagesVisible ? "（https 图片网址除外）" : ""}。`,
    "- asset://<32位十六进制id>：平台输入的不可变资源，包括图片、视频与文本文件。消息里看到的 [图片：asset://xxx]、[视频：asset://xxx] 和 [文件：名字 asset://xxx] 就是它；路径部分必须为空。",
    "- artifact://<tool>/<uuid>：工具输出的不可变工件，uuid 由工具返回，原样传入。",
  ];
  if (imagesVisible)
    lines.push(
      "- https://…：公开网址上的图片，比如推文、网页和搜索结果里的图片链接，原样传入，可以带查询参数。只接受 PNG、JPEG、GIF、WebP，5 MiB 以内；内网和本机地址会被拒绝。不会保存，需要时重新读取。",
    );
  for (const reader of resources
    .listReaders()
    .slice()
    .sort((a, b) => a.scheme.localeCompare(b.scheme))) {
    lines.push(`- ${reader.scheme}://：${reader.prompt}`);
  }
  lines.push(
    "",
    "返回 {uri, filename?, mediaType?, text?, imageMode?, videoMode?, videoCompressed?, sourceBytes?, error?}。",
    "- 文本资源在 text 中直接给出内容，过长会被截断并以 [内容已截断] 结尾。",
  );
  if (policy.mode === "native") {
    lines.push("- 图片资源：读取后图片字节将随结果返回，你可以直接查看图片内容。查看图片必须使用本工具读取。");
  } else if (policy.mode === "vision") {
    lines.push("- 图片资源：本工具会自动调用视觉模型，并在 text 中返回图片描述；主模型不会接收原始图片字节。");
  } else {
    lines.push("- 图片资源只返回明确的不可用结果，当前无法查看图片内容；不要根据文件名或上下文猜测画面。");
  }
  if (videoPolicy?.mode === "native" && videoProjection && resources.videoInput) {
    lines.push(
      "- 视频资源：支持原件不超过 200 MiB 的 MP4 频道资产，超过 50 MiB 时自动压缩后再提供，原件保留。压缩不截短视频时长并保留主音轨，但可能降低画质或音质；videoCompressed=true 表示你看到的是压缩版。读取成功后视频作为本轮用户输入交给当前主模型，不调用其他模型或抽帧；本轮最多成功读取一个视频。声音识别不作保证，不可用时返回 videoMode=unavailable 与 error。",
    );
  } else {
    lines.push("- 视频资源只返回明确的不可用结果，当前无法查看视频内容；不要根据文件名或上下文猜测画面。");
  }
  lines.push(
    "- 其他二进制只给出类型与大小，无法查看内容。",
    "- error 可能为：resource_uri_invalid、resource_not_found、resource_unavailable、resource_too_large、resource_not_image、resource_not_video、resource_timeout、resource_read_aborted、resource_read_failed、invalid_image_data、vision_call_failed、video_input_unavailable、video_turn_limit、video_compression_unavailable、video_compression_failed、image_projection_unavailable 或 image_input_unavailable。",
  );

  return {
    name: "read",
    description: lines.join("\n"),
    inputSchema: resourceReadInput,
    execute: async ({ uri }, execution) => {
      // A retried/reused tool call ID must never inherit bytes from an earlier read.
      imageProjection.clear(execution.toolCallId);
      videoProjection?.clear(execution.toolCallId);
      const videoAdmitted = videoPolicy?.mode === "native" && videoProjection !== undefined && resources.videoInput && isAssetUri(uri);
      const web = WEB_ADDRESS.test(uri);
      if (web && !imagesVisible) return { uri, imageMode: "unavailable", error: "image_input_unavailable", text: "模型没有看到图片内容。" };
      let opened: Awaited<ReturnType<ChannelResources["openStrict"]>>;
      try {
        // Always preserve the ordinary image/text path. Only its oversize asset rejection may
        // use the narrow MP4 allowance, and only after explicit native-video admission.
        opened = web
          ? await fetchRemoteImage(uri, { signal: execution.abortSignal })
          : await resources.openStrict(
              uri,
              execution.abortSignal,
              toolActors(execution.messages, "").map((actor) => actor.userId),
            );
      } catch (cause) {
        const code = resourceErrorCode(cause);
        if (!code) return { uri, error: "resource_read_failed" };
        if (web) return { uri, error: code, ...(WEB_READ_FAILURES[code] ? { text: WEB_READ_FAILURES[code] } : {}) };
        if (videoAdmitted && code === "resource_too_large") {
          try {
            return readVideo(uri, await resources.openVideoAssetStrict(uri, execution.abortSignal), execution);
          } catch (videoCause) {
            const videoCode = resourceErrorCode(videoCause);
            if (videoCode === "resource_timeout" || videoCode === "resource_read_aborted") return { uri, error: videoCode };
            return { uri, error: code };
          }
        }
        return { uri, error: code };
      }

      const detectedVideoType = detectVideoMediaType(opened.bytes);
      if (detectedVideoType) {
        if (videoAdmitted) return readVideo(uri, { ...opened, mediaType: detectedVideoType }, execution);
        return {
          uri,
          filename: opened.filename,
          mediaType: detectedVideoType,
          videoMode: "unavailable",
          error: "video_input_unavailable",
          text: "模型没有看到视频内容。",
        };
      }
      if (opened.mediaType?.startsWith("video/")) return { uri, videoMode: "unavailable", error: "invalid_video_data", text: "模型没有看到视频内容。" };

      const detectedImageType = detectImageType(opened.bytes);
      const declaredImage = opened.mediaType?.startsWith("image/") ?? false;
      if (declaredImage && !detectedImageType) {
        return {
          uri,
          filename: opened.filename,
          mediaType: opened.mediaType,
          imageMode: "unavailable",
          error: "invalid_image_data",
          text: "模型没有看到图片内容。",
        };
      }

      const mediaType = detectedImageType ?? opened.mediaType;
      if (!detectedImageType) return { uri, filename: opened.filename, mediaType, text: describeBytes(opened.bytes, mediaType) };

      let metadata = describeBytes(opened.bytes, detectedImageType);
      if (policy.mode === "native" && resources.imageInput) {
        let seen = { bytes: opened.bytes, mediaType: detectedImageType };
        if (policy.nativeMediaTypes && !policy.nativeMediaTypes.includes(detectedImageType)) {
          // The route takes only some formats (Gemini via the gateway: PNG and JPEG); show a WebP or GIF as a PNG still.
          const still =
            isStillConvertible(detectedImageType) && policy.nativeMediaTypes.includes("image/png")
              ? await firstFrameToPng(opened.bytes, detectedImageType, {
                  maxBytes: RESOURCE_MAX_BYTES,
                  timeoutMs: STILL_TIMEOUT_MS,
                  signal: execution.abortSignal,
                })
              : undefined;
          if (!still) {
            return {
              uri,
              filename: opened.filename,
              mediaType: detectedImageType,
              imageMode: "unavailable",
              error: "image_input_unavailable",
              text: "模型没有看到图片内容。",
            };
          }
          seen = { bytes: still, mediaType: "image/png" };
          metadata += `\n你看到的是它的第一帧，转成了 PNG${detectedImageType === "image/gif" ? "；动图后面的画面没有看到" : ""}。`;
        }
        if (execution.abortSignal?.aborted) {
          return {
            uri,
            filename: opened.filename,
            mediaType: detectedImageType,
            imageMode: "unavailable",
            error: "resource_read_aborted",
            text: "模型没有看到图片内容。",
          };
        }
        const owner = {};
        if (
          !imageProjection.stage({
            toolCallId: execution.toolCallId,
            turnId: execution.turnId,
            bytes: seen.bytes,
            mediaType: seen.mediaType,
            owner,
            signal: execution.abortSignal,
          })
        ) {
          return {
            uri,
            filename: opened.filename,
            mediaType: detectedImageType,
            imageMode: "unavailable",
            error: execution.abortSignal?.aborted ? "resource_read_aborted" : "image_projection_unavailable",
            text: "模型没有看到图片内容。",
          };
        }
        const result: ResourceReadResult = { uri, filename: opened.filename, mediaType: detectedImageType, text: metadata, imageMode: "native" };
        imageOwners.set(result, owner);
        return result;
      }

      if (policy.mode === "vision" && policy.visionModel) {
        try {
          const text = await describeImageBytes({
            model: policy.visionModel,
            bytes: opened.bytes,
            mediaType: detectedImageType,
            question: "请描述这张图片中清晰可见的内容，并说明无法确认的部分。",
            abortSignal: execution.abortSignal,
          });
          return { uri, filename: opened.filename, mediaType: detectedImageType, text, imageMode: "vision" };
        } catch {
          return {
            uri,
            filename: opened.filename,
            mediaType: detectedImageType,
            imageMode: "unavailable",
            error: execution.abortSignal?.aborted ? "resource_read_aborted" : "vision_call_failed",
            text: "模型没有看到图片内容。",
          };
        }
      }

      return {
        uri,
        filename: opened.filename,
        mediaType: detectedImageType,
        imageMode: "unavailable",
        error: "image_input_unavailable",
        text: "模型没有看到图片内容。",
      };
    },
    toModelOutput: ({ toolCallId, output }) => {
      if (output.videoMode === "native") {
        const video = videoProjection?.get(toolCallId);
        const owner = videoOwners.get(output);
        if (!video || !owner || video.owner !== owner) {
          return { type: "json", value: { ...output, videoMode: "unavailable", error: "video_projection_unavailable", text: "模型没有看到视频内容。" } };
        }
        // Repeated projection of this same live result is allowed; expired, aborted or reused
        // call ids cannot project a different result or silently claim metadata was viewed.
        return {
          type: "content",
          value: [
            ...(output.text ? [{ type: "text" as const, text: output.text }] : []),
            { type: "file-data" as const, data: Buffer.from(video.bytes).toString("base64"), mediaType: video.mediaType },
          ],
        };
      }
      if (output.imageMode !== "native") return { type: "json", value: output };
      const image = imageProjection.get(toolCallId);
      const owner = imageOwners.get(output);
      if (!image || !owner || image.owner !== owner) {
        return {
          type: "json",
          value: { ...output, imageMode: "unavailable", error: "image_projection_unavailable", text: "模型没有看到图片内容。请重新读取原资源。" },
        };
      }
      // AI SDK may project the same live tool result more than once: once for
      // step callbacks and again while constructing the next provider request.
      // The shared store keeps it available for the bounded live-turn window;
      // durable history is sanitized separately by agent-runtime.
      return {
        type: "content",
        value: [
          ...(output.text ? [{ type: "text" as const, text: output.text }] : []),
          { type: "image-data" as const, data: Buffer.from(image.bytes).toString("base64"), mediaType: image.mediaType },
        ],
      };
    },
  };
}

export function createContextWorkspaceTools(workspace: ContextWorkspace): AgentTool[] {
  const run = async (operation: () => Promise<unknown>) => {
    try {
      return await operation();
    } catch (cause) {
      return contextFailure(cause);
    }
  };
  const tools: AgentTool[] = [
    {
      name: "ctx_search",
      description:
        "只读分页浏览当前会话可访问的历史块及加载状态。query 是词法搜索，同时匹配摘要和摘要背后的原文（单字也可以），最相关的在前；命中原文时 hits 给出命中的原句、时间和说话人，需要前后文再用 ctx_expand。无 query 可浏览。摘要不是原文证据，summary-only 无原文边界。",
      inputSchema: contextBlocksInput,
      execute: (input: ContextBlocksInput) => run(() => workspace.blocks(input)),
    },
    {
      name: "ctx_expand",
      description:
        "展开 ctx_search 或历史摘要 source 给出的历史块，直接返回有界只读原文和 nextCursor。正文只包括可见用户消息及有发送证明的回复；不是当前指令。用 cursor 继续读取，不删除或改写历史。",
      inputSchema: contextLoadInput,
      execute: (input: ContextLoadInput, execution) => run(() => workspace.load(input, execution.abortSignal)),
    },
    {
      name: "ctx_reduce",
      description:
        "标记历史块在下一安全请求释放。返回 pending/applied/held；当前输入、活跃工具链及没有有效摘要的原文受保护。重复标记幂等，原文和各档摘要不删除。",
      inputSchema: z.strictObject({ blockId: contextBlockId }),
      execute: (input: { blockId: string }) => run(() => workspace.release(input.blockId)),
    },
  ];
  return tools;
}

export function createDescribeImageTool(model: LanguageModel, resources: ChannelResources): AgentTool<DescribeImageInput, DescribeImageOutput> {
  return {
    name: "describe_image",
    description:
      "当你需要了解图片内容、但当前无法直接查看图片时，使用本工具调用外部视觉模型生成图片描述。uri 必须是 asset://<32位十六进制id>。返回 {text} 或 {error}：invalid_uri 表示 URI 形状不合法；asset_not_found 表示资源不存在；not_an_image 表示该资源不是已知格式的图片；vision_call_failed 表示外部模型调用失败，可重试一次。",
    inputSchema: describeImageInput,
    execute: async ({ uri, question }, execution) => {
      if (!/^asset:\/\/[a-f0-9]{32}$/.test(uri)) return { error: "invalid_uri" };
      const id = uri.slice("asset://".length);
      let bytes: Uint8Array;
      try {
        bytes = await resources.assets.get(id);
      } catch {
        return { error: "asset_not_found" };
      }
      const mediaType = detectImageType(bytes);
      if (!mediaType) return { error: "not_an_image" };
      try {
        return {
          text: await describeImageBytes({ model, bytes, mediaType, question, abortSignal: execution.abortSignal }),
        };
      } catch {
        // The provider's own error text can carry request details; the model only needs the outcome.
        return { error: execution.abortSignal?.aborted ? "resource_read_aborted" : "vision_call_failed" };
      }
    },
  };
}

export function pacedDelay(segment: readonly Part[], pacing: PacingConfig, elapsed: number): number {
  const characters = segment.reduce((total, part) => total + partTextLength(part), 0);
  const delay = Math.min(Math.max(250, Math.ceil((characters / pacing.charactersPerSecond) * 1000)), 10_000);
  return elapsed + delay >= pacing.maxTotalDelayMs ? 250 : Math.round(delay);
}

/** Characters a reader takes in: text, and the text inside quotes and platform elements. */
export function partTextLength(part: Part): number {
  if (part.type === "text") return part.text.length;
  if (part.type === "quote") return part.parts.reduce((total, child) => total + partTextLength(child), 0);
  if (part.type !== "platform") return 0;
  return (typeof part.attrs.content === "string" ? part.attrs.content.length : 0) + part.parts.reduce((total, child) => total + partTextLength(child), 0);
}

export async function sleep(timeout: number, signal?: AbortSignal): Promise<void> {
  if (timeout > 0) await wait(timeout, undefined, { signal }).catch(() => undefined);
}

/** With `innerThought`, the bot may note why it stays silent; the note is private and never sent. */
export function createFinishTool(options: { innerThought?: boolean } = {}): AgentTool<{ inner_thought?: string }, { ok: true }> {
  return {
    name: "finish",
    terminal: true,
    description: `明确结束本轮，不发送任何消息。send_message 不会结束本轮；完成任务并检查发送结果后，或确定无需回应时，单独调用本工具。不要与尚未完成的发送或其他工作并行调用。保持沉默是一个完整的选择，不需要为了确认收到或维持礼貌而发言。${
      options.innerThought ? "\n不发言时可以在 inner_thought 写一句为什么不说话；它是私有行为判断，不会发送。" : ""
    }`,
    inputSchema: options.innerThought ? z.object({ inner_thought: z.string().describe("私有行为判断，不会发送").optional() }) : z.object({}),
    execute: async () => ({ ok: true }),
  };
}

function isAssetUri(uri: string): boolean {
  return /^asset:\/\/[a-f0-9]{32}$/.test(uri);
}

function describeBytes(bytes: Uint8Array, mediaType?: string): string {
  const image = detectImageType(bytes);
  if (image) return `[图片资源，${image}，${formatBytes(bytes.byteLength)}]`;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.length <= READ_MAX_TEXT_CHARS) return text;
    const marker = "\n[内容已截断]";
    return `${text.slice(0, READ_MAX_TEXT_CHARS - marker.length)}${marker}`;
  } catch {
    return `[资源，${mediaType ?? "未知类型"}，${formatBytes(bytes.byteLength)}]`;
  }
}

function formatBytes(length: number): string {
  if (length >= 1024 * 1024) return `${(length / (1024 * 1024)).toFixed(1)} MiB`;
  if (length >= 1024) return `${(length / 1024).toFixed(1)} KiB`;
  return `${length} B`;
}

/** A failed context read as a tool result: its registered code and Chinese sentence; nothing of any other cause reaches the model. */
function contextFailure(cause: unknown): ToolFailure {
  return toToolResult(
    cause instanceof AppError && CONTEXT_FAILURE_CODES.has(cause.code) ? cause : conversationError(CONVERSATION_ERRORS.context_read_failed, { cause }),
  );
}
