import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentTool } from "@yesimbot/agent-runtime";
import { afterEach, expect, it, vi } from "vitest";

import { TASK_ERRORS, taskError } from "../src/tasks/errors.js";
import { Tasks } from "../src/tasks/manager.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// Preview records, 2026-11-13 → 11-20: the daily briefing pasted its whole page into four content tasks. The model
// service cut long instructions at about 3,200 characters, and no task produced the page.
it("refuses a delegation that carries a whole HTML document and says how to render it instead", async () => {
  const path = await mkdtemp(join(tmpdir(), "yib-html-instruction-"));
  dirs.push(path);
  const prepare = vi.fn(async () => {
    throw taskError(TASK_ERRORS.task_bot_unavailable);
  });
  const manager = new Tasks(path, { prepare, notify: async () => "delivered", diagnostic: vi.fn(), changed: () => {} });
  await manager.start();
  try {
    const create = (manager.plugin({ channel: "channel-a", session: "first.jsonl" }).tools as AgentTool[]).find((tool) => tool.name === "task_create")!;
    const execution = (toolCallId: string) => ({ turnId: "turn", toolCallId, messages: [] }) as never;
    const refused = [];
    for (const [index, instruction] of [
      "请渲染下面的早报，宽度 1000：\n<!DOCTYPE html>\n<html><head><style>body{margin:0}</style></head><body>早报</body></html>",
      '渲染：<html lang="zh-CN"><body><h1>早报</h1></body></html>',
    ].entries())
      refused.push(await create.execute({ kind: "content", timeLimitMinutes: 30, instruction }, execution(`html-${index}`)));
    expect(refused).toEqual([
      expect.objectContaining({ ok: false, executionStatus: "not_started", error: expect.objectContaining({ code: "task_instruction_html" }) }),
      expect.objectContaining({ ok: false, executionStatus: "not_started", error: expect.objectContaining({ code: "task_instruction_html" }) }),
    ]);
    expect((refused[0] as { error: { message: string } }).error.message).toContain("自己调用渲染工具");
    expect(await manager.store.list()).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    // A file path, a tool name or a single tag is not a document.
    const created = await create.execute(
      { kind: "content", timeLimitMinutes: 30, instruction: "用 render_html 渲染工作目录里的 briefing.html，标题保留 <h1>" },
      execution("path"),
    );
    expect(created).toMatchObject({ kind: "content", instruction: "用 render_html 渲染工作目录里的 briefing.html，标题保留 <h1>" });
  } finally {
    await manager.stop();
  }
});
