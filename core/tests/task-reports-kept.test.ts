import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jsonSchema, type AgentTool } from "@yesimbot/agent-runtime";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";

import { Tasks } from "../src/tasks/manager.js";
import { TaskStore } from "../src/tasks/store.js";

// Pipeline audit of the 雨云 komari-agent tasks, 2026-11-20: reports lost on cancel, continuations starting blind,
// and a report that left out what it changed.
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const origin = { channel: "channel-a", session: "first.jsonl" };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
type Step = { text?: string; tool: string; input: unknown };
const stream = (step: Step, id: string) => ({
  stream: convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    ...(step.text
      ? [
          { type: "text-start", id: `${id}-text` },
          { type: "text-delta", id: `${id}-text`, delta: step.text },
          { type: "text-end", id: `${id}-text` },
        ]
      : []),
    { type: "tool-call", toolCallId: id, toolName: step.tool, input: JSON.stringify(step.input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
  ] as never),
});

async function harness(steps: Step[], hold?: Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), "yib-task-kept-"));
  dirs.push(path);
  const prompts: string[] = [];
  const executed: string[] = [];
  const exec: AgentTool<{ command: string }> = {
    name: "computer_exec",
    description: "run a command",
    inputSchema: jsonSchema({ type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false }),
    execute: async ({ command }) => {
      executed.push(command);
      if (command.startsWith("curl") && hold) await hold;
      return { status: "succeeded", output: { exitCode: 0, stdout: "" } };
    },
  };
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return stream(steps[prompts.length - 1]!, `call-${prompts.length}`) as never;
    },
  });
  const notify = vi.fn(async () => "delivered" as const);
  const manager = new Tasks(path, { prepare: async () => ({ config: { model, tools: [exec as AgentTool] } }), notify, diagnostic: vi.fn(), changed: vi.fn() });
  await manager.start();
  return { manager, prompts, executed, notify };
}

it("keeps a waiting task's report when the main conversation ends it", async () => {
  const { manager } = await harness([]);
  const { record } = await manager.store.create({ ...origin, key: "waiting", kind: "computer", instruction: "上传 komari-agent" });
  await manager.store.update(record.id, (row) => {
    row.status = "waiting";
    row.result = "已经上传并校验 /tmp/komari-agent，sha256 一致；剩下启动服务。";
  });
  const cancelled = await manager.cancel(record.id, origin.channel);
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.result).toBe("已经上传并校验 /tmp/komari-agent，sha256 一致；剩下启动服务。\n（主对话已结束这项任务；已完成的外部操作不会自动撤销。）");
  await manager.stop();
});

it("keeps what a running task did, and its last words, when it is cancelled", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const { manager, executed } = await harness(
    [
      { text: "先备份配置。", tool: "computer_exec", input: { command: "cp ~/.ssh/config ~/.ssh/config.bak" } },
      { tool: "computer_exec", input: { command: "curl -L -o /tmp/komari.tar.gz https://example.com/komari.tar.gz" } },
    ],
    hold,
  );
  try {
    const task = await manager.create(origin, "computer", "装 komari-agent", "key", [], { timeLimitMinutes: 30 });
    await vi.waitFor(() => expect(executed).toHaveLength(2));
    const cancelled = await manager.cancel(task.id, origin.channel);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.result).toContain("任务已取消；已完成的外部操作不会自动撤销。");
    // The download it was in the middle of is cut off by the cancel and listed too.
    expect(cancelled.result).toContain("停止前代理一共调用了 2 次工具（computer_exec ×2）");
    expect(cancelled.result).toContain(
      "执行过的改动（不是只读的命令和文件写入，共 2 项）：\n- computer_exec command=cp ~/.ssh/config ~/.ssh/config.bak → 完成\n- computer_exec command=curl -L -o /tmp/komari.tar.gz",
    );
    expect(cancelled.result).toContain("代理最后写下的说明（没有通过 task_report 提交，内容未经核实）：\n先备份配置。");
    release();
    await vi.waitFor(async () => expect((await manager.store.get(task.id))?.status).toBe("cancelled"));
    expect((await manager.store.get(task.id))?.result).toBe(cancelled.result);
  } finally {
    release();
    await manager.stop();
  }
});

it("starts a continuation with the first delegation and every earlier round's report", async () => {
  const { manager, prompts } = await harness([{ tool: "task_report", input: { status: "succeeded", result: "服务已启动" } }]);
  const round = async (key: string, instruction: string, result: string, continues?: string) => {
    const { record } = await manager.store.create({
      ...origin,
      key,
      kind: "computer",
      instruction,
      ...(continues ? { continues: { taskId: continues, depth: 1 } } : {}),
    });
    return manager.store.update(record.id, (row) => {
      row.status = "failed";
      row.result = result;
      row.artifacts = key === "second" ? ["/tmp/komari-agent-1.5.11"] : [];
    });
  };
  // Like the 雨云 relay: the first delegation's small requirement must survive every handover.
  const first = await round("first", "在雨云服务器上装好 komari-agent。装之前先停掉游戏客户端。", "游戏客户端已停；下载到一半网络断了。");
  const second = await round("second", "接着装 komari-agent", "agent 已经解压在 /tmp/komari-agent-1.5.11；pip 要换清华源才能装上。", first.id);
  const task = await manager.create(origin, "computer", "接着启动 komari-agent", "third", [], { continues: second.id, timeLimitMinutes: 30 });
  // The result is handed over after the task ends; stopping before that write lands leaves it writing into a removed directory.
  await vi.waitFor(async () => expect(await manager.store.get(task.id)).toMatchObject({ status: "succeeded", notification: "delivered" }));
  const prompt = prompts[0]!;
  expect(prompt).toContain("已经接力 2 轮");
  expect(prompt).toContain("最初的委派：\\n在雨云服务器上装好 komari-agent。装之前先停掉游戏客户端。");
  expect(prompt).toContain(`【第 1 轮 ${first.id}，状态 failed】\\n游戏客户端已停；下载到一半网络断了。`);
  expect(prompt).toContain(`【第 2 轮 ${second.id}，状态 failed，上一轮】\\nagent 已经解压在 /tmp/komari-agent-1.5.11；pip 要换清华源才能装上。`);
  expect(prompt).toContain("留下的资源：/tmp/komari-agent-1.5.11");
  expect(prompt).toContain("最初委派里的要求仍然有效");
  await manager.stop();
});

// The bot's own account, 2026-11-20: 「后台中断时只知道"挂了"，不知道挂在哪」.
it("tells where a task cut off by a process loss had got to, from its transcript", async () => {
  const path = await mkdtemp(join(tmpdir(), "yib-task-kept-"));
  dirs.push(path);
  const store = new TaskStore(path);
  const { record } = await store.create({ ...origin, key: "lost", kind: "computer", instruction: "装 komari-agent" });
  await store.update(record.id, (row) => {
    row.status = "running";
  });
  const message = (role: string, content: unknown[]) => JSON.stringify({ type: "message", id: role + content.length, data: { role, content } });
  await writeFile(
    join(path, record.id + ".jsonl"),
    [
      message("user", [{ type: "text", text: "装 komari-agent" }]),
      message("assistant", [
        { type: "text", text: "先备份配置再下载。" },
        { type: "tool-call", toolCallId: "a", toolName: "computer_exec", input: { command: "cp ~/.ssh/config ~/.ssh/config.bak" } },
      ]),
      message("tool", [
        { type: "tool-result", toolCallId: "a", toolName: "computer_exec", output: { type: "json", value: { status: "succeeded", output: { exitCode: 0 } } } },
      ]),
      message("assistant", [
        { type: "tool-call", toolCallId: "b", toolName: "computer_exec", input: { command: "curl -L -o /tmp/k.tgz https://example.com/k.tgz" } },
      ]),
      "not json",
    ].join("\n"),
  );
  const notify = vi.fn(async () => "delivered" as const);
  const manager = new Tasks(path, { prepare: vi.fn(), notify, diagnostic: vi.fn(), changed: vi.fn() });
  await manager.start();
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
  const result = (await manager.store.get(record.id))!.result!;
  expect(result).toContain("进程中断，执行结果需要核实；未自动重新执行。");
  expect(result).toContain("停止前代理一共调用了 2 次工具（computer_exec ×2）");
  expect(result).toContain("2. computer_exec command=curl -L -o /tmp/k.tgz https://example.com/k.tgz → 未完成 进程中断时还在执行");
  expect(result).toContain("- computer_exec command=cp ~/.ssh/config ~/.ssh/config.bak → 完成");
  expect(result).toContain("代理最后写下的说明（没有通过 task_report 提交，内容未经核实）：\n先备份配置再下载。");
  await manager.stop();
});

it("lists what a task changed with its report, leaving out what it only read", async () => {
  const { manager } = await harness([
    { tool: "computer_exec", input: { command: "rm -f /tmp/q.py /tmp/sftp_put.py" } },
    { tool: "computer_exec", input: { command: "ls -la /tmp" } },
    { tool: "task_report", input: { status: "succeeded", result: "清理完毕" } },
  ]);
  const task = await manager.create(origin, "computer", "清理临时文件", "key", [], { timeLimitMinutes: 30 });
  // The result is handed over after the task ends; stopping before that write lands leaves it writing into a removed directory.
  await vi.waitFor(async () => expect(await manager.store.get(task.id)).toMatchObject({ status: "succeeded", notification: "delivered" }));
  expect((await manager.store.get(task.id))?.result).toBe(
    "清理完毕\n执行过的改动（不是只读的命令和文件写入，共 1 项）：\n- computer_exec command=rm -f /tmp/q.py /tmp/sftp_put.py → 完成",
  );
  await manager.stop();
});
