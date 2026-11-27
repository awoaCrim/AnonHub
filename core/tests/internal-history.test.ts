import { createAssistantMessage, createEntry, createToolMessage, createUserMessage } from "@yesimbot/agent-runtime";
import { describe, expect, it } from "vitest";

import { collectDeliveredSourceRecords, stripInternalAssistantInputs } from "../src/conversations/internal-history.js";
import { createEvent } from "../src/messages/index.js";

describe("internal model-history projection", () => {
  it("keeps a past event only as its history note, with that run's own output", () => {
    const event = (id: string, extra: Record<string, unknown>) =>
      createEntry(
        "message",
        createEvent({
          eventType: "schedule.due",
          platform: "web",
          selfId: "bot",
          timestamp: 1,
          channel: { id: "owner", type: 1 },
          text: "长篇的一次性心跳指令",
          ...extra,
        } as never),
        { id, timestamp: 1 },
      );
    const output = createEntry("message", createAssistantMessage([{ type: "text", text: "查过邮件：Tavily 用到 80%。" }]), { id: "out", timestamp: 2 });
    const projected = stripInternalAssistantInputs([event("noted", { historyNote: "之前的一次心跳检查（计划「心跳」）" }), event("plain", {}), output]);
    expect(projected.map((entry) => entry.id)).toEqual(["noted", "out"]);
    const kept = projected[0]!.data as { data: { text: string; eventType: string } };
    expect(kept.data).toMatchObject({ eventType: "schedule.due", text: "之前的一次心跳检查（计划「心跳」）" });
    expect(JSON.stringify(projected)).not.toContain("一次性心跳指令");
  });

  it("removes prior internal tool fields without changing durable entries", () => {
    const assistant = createAssistantMessage([
      {
        type: "tool-call",
        toolCallId: "read-1",
        toolName: "read",
        input: {
          uri: "asset://abc",
          inner_thought: "对方只是问了一个简单问题，不需要继续表演。",
          reason: "不应进入后续模型上下文。",
        },
      },
      {
        type: "tool-call",
        toolCallId: "finish-1",
        toolName: "finish",
        input: { reason: "当前消息没有明确指向我。" },
      },
    ]);
    const entries = [
      createEntry("message", createUserMessage("请保持简洁"), { id: "user-1", timestamp: 1 }),
      createEntry("message", assistant, { id: "assistant-1", timestamp: 2 }),
    ];

    const projected = stripInternalAssistantInputs(entries);
    const projectedAssistant = projected[1];
    expect(projectedAssistant).not.toBe(entries[1]);
    expect(entries[1]).toEqual(expect.objectContaining({ data: expect.objectContaining({ content: assistant.content }) }));
    expect(projectedAssistant).toEqual(
      expect.objectContaining({
        id: "assistant-1",
        data: expect.objectContaining({
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "read-1",
              toolName: "read",
              input: { uri: "asset://abc" },
            },
            {
              type: "tool-call",
              toolCallId: "finish-1",
              toolName: "finish",
              input: {},
            },
          ],
        }),
      }),
    );
  });

  it("hides ephemeral image traces but keeps durable reads", () => {
    const assistant = createAssistantMessage([
      { type: "tool-call", toolCallId: "asset-read", toolName: "read", input: { uri: "asset://reference" } },
      { type: "tool-call", toolCallId: "artifact-read", toolName: "read", input: { uri: "artifact://generate_image/result" } },
      { type: "tool-call", toolCallId: "image", toolName: "generate_image", input: { prompt: "old image" } },
      { type: "tool-call", toolCallId: "finish", toolName: "finish", input: {} },
    ]);
    const tool = createToolMessage([
      { type: "tool-result", toolCallId: "asset-read", toolName: "read", output: { type: "json", value: { asset: true } } },
      { type: "tool-result", toolCallId: "artifact-read", toolName: "read", output: { type: "json", value: { artifact: true } } },
      { type: "tool-result", toolCallId: "image", toolName: "generate_image", output: { type: "json", value: { uri: "artifact://generate_image/result" } } },
      { type: "tool-result", toolCallId: "finish", toolName: "finish", output: { type: "json", value: { done: true } } },
    ]);

    const projected = stripInternalAssistantInputs([
      createEntry("message", assistant, { id: "assistant-1", timestamp: 1 }),
      createEntry("message", tool, { id: "tool-1", timestamp: 2 }),
    ]);

    expect(projected[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          content: [
            { type: "tool-call", toolCallId: "asset-read", toolName: "read", input: { uri: "asset://reference" } },
            { type: "tool-call", toolCallId: "finish", toolName: "finish", input: {} },
          ],
        }),
      }),
    );
    expect(projected[1]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          content: [
            { type: "tool-result", toolCallId: "asset-read", toolName: "read", output: { type: "json", value: { asset: true } } },
            { type: "tool-result", toolCallId: "finish", toolName: "finish", output: { type: "json", value: { done: true } } },
          ],
        }),
      }),
    );
  });

  it.each(["default", "gemini-native"] as const)("keeps native send calls and success/failure results in source order (%s)", (mode) => {
    for (const output of [
      { ok: true, messageIds: ["id"], count: 1 },
      { ok: false, sent: ["id"], failedAt: 1 },
      { ok: false, sent: [], failedAt: 0 },
    ]) {
      const entries = [
        createEntry("message", createUserMessage("question")),
        createEntry(
          "message",
          createAssistantMessage([
            {
              type: "tool-call",
              toolName: "send_message",
              toolCallId: "send",
              input: { parts: [{ kind: "text", text: "draft" }], inner_thought: "private" },
              providerOptions: { google: { thoughtSignature: "signed" } },
            },
          ]),
        ),
        createEntry(
          "message",
          createToolMessage([{ type: "tool-result", toolName: "send_message", toolCallId: "send", output: { type: "json", value: output } }]),
        ),
        createEntry("message", createUserMessage("next")),
      ];
      const before = JSON.stringify(entries);
      const result = stripInternalAssistantInputs(entries, mode);
      expect(result.map((e) => e.id)).toEqual(entries.map((e) => e.id));
      expect(result[1]).toMatchObject({
        data: { content: [{ input: { parts: [{ kind: "text", text: "draft" }] }, providerOptions: { google: { thoughtSignature: "signed" } } }] },
      });
      expect(result[2]).toEqual(entries[2]);
      expect(JSON.stringify(result)).not.toMatch(/private|delivered.transcript/);
      expect(JSON.stringify(entries)).toBe(before);
      expect(stripInternalAssistantInputs(result, mode)).toEqual(result);
    }
  });
  it("drops unpaired and ambiguous sends rather than fabricating results", () => {
    const call = createEntry("message", createAssistantMessage([{ type: "tool-call", toolName: "send_message", toolCallId: "s", input: { parts: [] } }]));
    const result = createEntry(
      "message",
      createToolMessage([{ type: "tool-result", toolName: "send_message", toolCallId: "s", output: { type: "json", value: { ok: true } } }]),
    );
    for (const entries of [[call], [result], [result, call], [call, call, result], [call, result, result]])
      expect(stripInternalAssistantInputs(entries)).toEqual([]);
  });
  it("counts a receipt only for the call's own messages", () => {
    const sent = (output: Record<string, unknown>) => [
      createEntry(
        "message",
        createAssistantMessage([{ type: "tool-call", toolName: "send_message", toolCallId: "s", input: { messages: ["first", "second"] } }]),
        {
          id: "call",
        },
      ),
      createEntry("message", createToolMessage([{ type: "tool-result", toolName: "send_message", toolCallId: "s", output: { type: "json", value: output } }])),
    ];
    const texts = (output: Record<string, unknown>) =>
      collectDeliveredSourceRecords(sent(output))
        .get("call")
        ?.map((r) => r.text);
    expect(texts({ ok: true, messageIds: ["a", "b"], count: 2 })).toEqual(["first", "second"]);
    expect(texts({ ok: false, sent: ["a"], failedAt: 1 })).toEqual(["first"]);
    expect(texts({ ok: true, messageIds: ["a"], count: 1 })).toBeUndefined();
  });
});
