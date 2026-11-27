import { expect, it } from "vitest";

import { conversationRecord } from "../web/src/lib/conversation-record";
import type { MainNode } from "../web/src/pages/conversation-detail-model";

it("keeps complete tool arguments and their paired result in one record detail", () => {
  const call: MainNode = { id: "call", kind: "tool-call", timestamp: 1, toolName: "read_file", args: { path: "notes.md", lines: [1, 2, 3] } };
  const result: MainNode = { id: "result", kind: "tool-result", timestamp: 2, result: { content: "完整文件正文", metadata: { revision: 7 } } };
  const record = conversationRecord(call, result);
  expect(record.label).toContain("read_file");
  expect(JSON.parse(record.sections[0]!.text)).toEqual(call.args);
  expect(JSON.parse(record.sections[1]!.text)).toEqual(result.result);
  expect(conversationRecord(call).sections[1]!.text).toBe("等待返回…");
  const failure = conversationRecord(call, { ...result, error: { name: "IOError", message: "文件暂不可读" } });
  expect(failure.sections[1]).toMatchObject({ error: true, text: "文件暂不可读" });
});

it("preserves attached thought text, every repeated policy decision, and compression content", () => {
  const assistant: MainNode = { id: "reply", kind: "assistant", timestamp: 1, thought: "完整思考", reply: "已经展示的回复" };
  expect(conversationRecord(assistant, undefined, true).sections).toEqual([{ title: "思考内容", text: "完整思考" }]);
  const policy: MainNode = {
    id: "policy",
    kind: "will",
    timestamp: 2,
    decision: "wait",
    repeats: [
      { timestamp: 2, willDebug: { score: 1 } },
      { timestamp: 3, willDebug: { score: 2 } },
    ],
  };
  const debug = conversationRecord(policy).sections[0]!.text;
  expect(debug).toContain('"score": 1');
  expect(debug).toContain('"score": 2');
});

it("keeps event text, failure information, and its original metadata available together", () => {
  const event: MainNode = { id: "event", kind: "event", timestamp: 1, eventType: "request.failed", text: "事件完整正文", error: { message: "完整错误原因" } };
  const record = conversationRecord(event);
  expect(record.sections).toContainEqual({ title: "事件内容", text: event.text });
  expect(record.sections).toContainEqual({ title: "异常信息", text: event.error!.message, error: true });
  expect(JSON.parse(record.sections.at(-1)!.text)).toEqual(event);
});
