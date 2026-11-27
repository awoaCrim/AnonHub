import type { AgentEntry, AgentMessage } from "@yesimbot/agent-runtime";
import type { Part } from "@yesimbot/contracts/parts";
import { formatForModel } from "@yesimbot/foundation";
import type { AssistantContent } from "ai";

import { DISPLAY_CLOCK } from "../display-clock.js";
import { compactPartsText } from "../messages/parts.js";

/** Semantic policy for the context-region historian prompt. */
export const HISTORY_SOURCE_POLICY = [
  "主要记录谁说了什么、发生了什么、是否确认及必要的事件时间；区分某人的自述、转述、已确认事实和机器人推测。确需保留未确认说法时，写明来源与未确认状态；重复记载不构成独立证据。",
  "不要把机器人对他人动机、性格或关系的猜测写成事实；一次性玩笑不能自动升级为固定称呼或长期关系。",
  "区分受托创作的作品内容、临时修辞与实际共同经历；只在后续引用确有价值时保留梗、作品名、明确固定称呼或关键承诺的原词，不把每次机器人吐槽当作高价值关系记忆或文风示范。",
  "保留有依据的承诺、约定、决定、约束、未完成事项和具体时间、地点、数量，不为去修辞而丢掉事实锚点。",
].join("\n");

export interface CompressionRecord {
  readonly entryId: string;
  readonly timestamp: number;
  readonly role: "user" | "assistant" | "event";
  readonly text: string;
  readonly speaker?: string;
}

/** Renders safe, non-tool records for context regions and read-only expansion. */
export function renderCompressionRecords(entry: AgentEntry): CompressionRecord[] {
  if (entry.type !== "message") return [];
  const message = entry.data as AgentMessage;
  if (message.role === "tool" || message.role === "system") return [];
  const timestamp = compactSourceTimestamp(entry);
  if (message.role === "custom") {
    const custom = message as AgentMessage & { type?: string; data?: { user?: { id?: string; name?: string }; parts?: Part[]; text?: string } };
    if (custom.type === "yesimbot.message") {
      const text = compactPartsText(custom.data?.parts);
      return text ? [{ entryId: entry.id, timestamp, role: "user", speaker: custom.data?.user?.name ?? custom.data?.user?.id ?? "user", text }] : [];
    }
    if (custom.type === "yesimbot.event" && custom.data?.text) return [{ entryId: entry.id, timestamp, role: "event", text: custom.data.text }];
    return [];
  }
  if (message.role === "user") {
    const text = typeof message.content === "string" ? message.content.trim() : "";
    return text ? [{ entryId: entry.id, timestamp, role: "user", text }] : [];
  }
  if (message.role !== "assistant") return [];
  const records: CompressionRecord[] = [];
  const text = assistantText(message.content);
  if (text) records.push({ entryId: entry.id, timestamp, role: "assistant", text });
  for (const spoken of assistantUtterances(message.content)) records.push({ entryId: entry.id, timestamp, role: "assistant", text: spoken });
  return records;
}

/**
 * Public source material for Magic Context: visible user input plus Core/plugin event text the
 * model was shown (e.g. a scheduled notice or an external-platform activity round). Event-driven
 * channels have no user messages; without their events nothing in them could ever be summarized.
 */
export function renderVisibleSourceRecords(entry: AgentEntry): CompressionRecord[] {
  return [...renderVisibleUserRecords(entry), ...renderCompressionRecords(entry).filter((record) => record.role === "event")];
}

export function renderVisibleUserRecords(entry: AgentEntry): CompressionRecord[] {
  if (entry.type !== "message" || entry.data.role !== "user") return renderCompressionRecords(entry).filter((record) => record.role === "user");
  const text =
    typeof entry.data.content === "string"
      ? entry.data.content
      : entry.data.content.map((part) => (part.type === "text" ? part.text : part.type === "image" ? "[图片]" : part.type === "file" ? "[文件]" : "")).join("");
  return text.trim() ? [{ entryId: entry.id, timestamp: compactSourceTimestamp(entry), role: "user", text }] : [];
}

/**
 * Uniform `Asia/Shanghai` minute precision for the historian prompt and search hits. A summary
 * must show the model when each fact happened; one without any time anchor cannot answer "when"
 * later, which is the failure this format exists to prevent.
 */
export function compactSourceTimestamp(entry: Extract<AgentEntry, { type: "message" }>): number {
  const timestamp = (entry.data as AgentMessage).timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : entry.timestamp;
}

/** When a source record was said, in the one time format (convention 06). */
export function formatCompactTimestamp(timestamp: number): string {
  return formatForModel(timestamp, DISPLAY_CLOCK);
}

/**
 * Outgoing messages reach the platform as `send_message` tool calls, so without projecting
 * them the historian never sees the character's own speech and a region keeps only the other
 * side: her commitments, stance and past decisions disappear once summarized, which surfaces as
 * persona drift and self-contradiction. `inner_thought` and
 * `finish.reason` are deliberately excluded - the prompt forbids recording internal reasoning.
 */
function assistantUtterances(content: AssistantContent): string[] {
  if (!Array.isArray(content)) return [];
  const utterances: string[] = [];
  for (const part of content) {
    if (part.type !== "tool-call" || part.toolName !== "send_message") continue;
    const messages = (part.input as Record<string, unknown> | undefined)?.messages;
    if (!Array.isArray(messages)) continue;
    const text = messages.filter((line): line is string => typeof line === "string" && line.trim().length > 0).join("\n");
    if (text) utterances.push(text);
  }
  return utterances;
}

function assistantText(content: AssistantContent): string {
  return typeof content === "string"
    ? content.trim()
    : Array.isArray(content)
      ? content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
          .trim()
      : "";
}
