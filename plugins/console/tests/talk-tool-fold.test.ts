import { expect, it } from "vitest";

import { foldToolResults, type MainNode } from "../web/src/pages/conversation-detail-model";

const node = (id: string, kind: MainNode["kind"], extra: Partial<MainNode> = {}): MainNode => ({ id, kind, timestamp: 0, ...extra });

it("shows each tool call once, with its own result folded under it", () => {
  const call = node("1", "tool-call", { toolCallId: "a", toolName: "computer_ui" });
  const result = node("2", "tool-result", { toolCallId: "a", result: { ok: true } });
  const failedCall = node("3", "tool-call", { toolCallId: "b" });
  const failed = node("4", "tool-result", { toolCallId: "b", error: { message: "超时" } });
  const pending = node("5", "tool-call", { toolCallId: "c" });
  // Its call was paged out above the screen, so the result keeps its own row.
  const orphan = node("6", "tool-result", { toolCallId: "z" });

  const { nodes, resultOf } = foldToolResults([call, result, failedCall, failed, pending, orphan]);

  expect(nodes.map((item) => item.id)).toEqual(["1", "3", "5", "6"]);
  expect(resultOf(call)).toBe(result);
  expect(resultOf(failedCall)?.error?.message).toBe("超时");
  expect(resultOf(pending)).toBeUndefined();
  expect(resultOf(orphan)).toBeUndefined();
});
