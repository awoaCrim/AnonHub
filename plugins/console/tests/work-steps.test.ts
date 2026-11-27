import { expect, it } from "vitest";

import { describeStep } from "../web/src/lib/work-steps";

// User, 2026-11-20: 「我需要可以点开查看具体的命令和对应的输出」.
it("shows a command in full with its exit code, output and errors", () => {
  const view = describeStep({
    id: "a",
    tool: "computer_exec",
    input: { command: "ssh -o ConnectTimeout=15 denver 'systemctl status komari-agent'", cwd: "/root", timeoutMs: 120000 },
    status: "failed",
    output: {
      status: "succeeded",
      output: { exitCode: 3, stdout: "inactive (dead)", stderr: "Unit komari-agent.service could not be found.", durationMs: 2300 },
    },
  });
  expect(view).toEqual({
    label: "命令行",
    summary: "ssh -o ConnectTimeout=15 denver 'systemctl status komari-agent'",
    command: "ssh -o ConnectTimeout=15 denver 'systemctl status komari-agent'",
    meta: ["目录 /root", "最多等 2 分钟", "退出码 3", "用时 2 秒"],
    outputs: [
      { label: "输出", text: "inactive (dead)" },
      { label: "错误输出", text: "Unit komari-agent.service could not be found.", error: true },
    ],
  });
  expect(
    describeStep({
      id: "b",
      tool: "computer_exec",
      input: { command: "true" },
      status: "ok",
      output: { status: "succeeded", output: { exitCode: 0, stdout: "" } },
    }).meta,
  ).toEqual(["退出码 0", "没有输出"]);
  expect(
    describeStep({
      id: "c",
      tool: "computer_exec",
      input: { command: "rm -rf /" },
      status: "failed",
      output: { status: "rejected", code: "dangerous_command", message: "这条命令会删除整个系统" },
    }).outputs,
  ).toEqual([{ label: "说明", text: "dangerous_command：这条命令会删除整个系统", error: true }]);
});

it("never shows what was typed into a page or the desktop", () => {
  const fill = describeStep({
    id: "a",
    tool: "computer_browser",
    input: { action: "fill", ref: "e3", text: "hunter2" },
    status: "ok",
    output: {
      status: "succeeded",
      output: { action: "fill", completed: true, page: { snapshot: "s", title: "登录", url: "https://app.rainyun.com/login", text: "欢迎" } },
    },
  });
  expect(fill.line).toBe("填写 e3（7 个字，不显示内容）");
  expect(fill.meta).toEqual(["页面：登录 · https://app.rainyun.com/login"]);
  expect(JSON.stringify(fill)).not.toContain("hunter2");
  const desktop = describeStep({
    id: "b",
    tool: "computer_ui",
    input: {
      action: "sequence",
      steps: [
        { action: "type_text", text: "secret-pass" },
        { action: "click", ref: "b1" },
      ],
    },
    status: "ok",
    output: { ok: true },
  });
  expect(desktop.input).toContain("（11 个字，不显示）");
  expect(JSON.stringify(desktop)).not.toContain("secret-pass");
  // A web terminal's typing may be a password too.
  const terminal = describeStep({ id: "c", tool: "computer_browser", input: { action: "type", targetId: "t", text: "sudo-pass\n" }, status: "ok" });
  expect(terminal.line).toBe("逐键输入（10 个字，不显示内容）");
  expect(JSON.stringify(terminal)).not.toContain("sudo-pass");
});

it("says what the browser's keys, wheel and uploads did", () => {
  const line = (input: Record<string, unknown>) => describeStep({ id: "x", tool: "computer_browser", input: { targetId: "t", ...input }, status: "ok" }).line;
  expect(line({ action: "hotkey", keys: "ctrl+c" })).toBe("组合键 ctrl+c");
  expect(line({ action: "scroll", x: 300, y: 420, dy: -3 })).toBe("在画面位置 (300, 420) 向上滚动 3 格");
  expect(line({ action: "upload", ref: "e4", files: ["out/report.pdf", "a.png"] })).toBe("上传 out/report.pdf、a.png 到 e4");
});

// User, 2026-11-26: 「右边顶部需要标注本次工具的摘要」.
it("sums each call up in one line: its command, its action, or what it was about", () => {
  const summary = (tool: string, input: unknown) => describeStep({ id: "a", tool, input, status: "ok" }).summary;
  expect(summary("computer_exec", { command: "cd /srv\nnpm install" })).toBe("cd /srv …");
  expect(summary("computer_browser", { action: "navigate", url: "https://example.com/" })).toBe("打开 https://example.com/");
  expect(summary("search_web", { maxResults: 5, query: "NapCat 二维码过期" })).toBe("NapCat 二维码过期");
  expect(summary("readFile", { path: "/srv/app/config.json" })).toBe("/srv/app/config.json");
  expect(summary("computer_exec", { command: "x".repeat(200) })).toBe(`${"x".repeat(160)}…`);
  expect(summary("computer_ui", { action: "type_text", text: "secret-pass" })).toBe("type_text");
  expect(summary("task_report", {})).toBe("状态：");
});
