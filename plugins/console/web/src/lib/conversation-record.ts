import { decisionLabel, eventTitle, prettyJson, type MainNode } from "../pages/conversation-detail-model";
import { formatTime } from "./format";

export interface ConversationRecordDetail {
  label: string;
  timestamp: number;
  sections: { title: string; text: string; error?: boolean }[];
}

/** One complete read view for a record, including a tool call's paired result. */
export function conversationRecord(node: MainNode, result?: MainNode, thoughtOnly = false): ConversationRecordDetail {
  if (thoughtOnly || node.kind === "thought")
    return { label: "思考", timestamp: node.timestamp, sections: [{ title: "思考内容", text: node.thought || "未记录思考内容。" }] };
  if (node.kind === "tool-call") {
    const sections: ConversationRecordDetail["sections"] = [{ title: "调用参数", text: prettyJson(node.args) }];
    if (result?.error) sections.push({ title: "执行异常", text: result.error.message || prettyJson(result.error), error: true });
    else sections.push({ title: "执行结果", text: result ? prettyJson(result.result) : "等待返回…" });
    return { label: `工具调用 · ${node.toolName || "工具"}`, timestamp: node.timestamp, sections };
  }
  if (node.kind === "tool-result")
    return {
      label: `工具结果 · ${node.toolName || "工具"}`,
      timestamp: node.timestamp,
      sections: [
        node.error
          ? { title: "执行异常", text: node.error.message || prettyJson(node.error), error: true }
          : { title: "执行结果", text: prettyJson(node.result) },
      ],
    };
  if (node.kind === "will") {
    const debug = node.repeats
      ? node.repeats.map((item) => `${formatTime(item.timestamp, "second")}\n${prettyJson(item.willDebug)}`).join("\n\n")
      : prettyJson(node.willDebug);
    return { label: decisionLabel(node.decision), timestamp: node.timestamp, sections: [{ title: "策略参数", text: debug }] };
  }
  return {
    label: eventTitle(node),
    timestamp: node.timestamp,
    sections: [
      ...(node.text ? [{ title: "事件内容", text: node.text }] : []),
      ...(node.error ? [{ title: "异常信息", text: node.error.message || prettyJson(node.error), error: true }] : []),
      { title: "事件记录", text: prettyJson(node) },
    ],
  };
}
