import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jsonSchema, type AgentTool } from "@yesimbot/agent-runtime";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { computerObservationAllowed } from "../src/tasks/computer-observation.js";
import { Tasks } from "../src/tasks/manager.js";
import { dangerousCommand, readOnlyCommand } from "../src/tasks/shell-command.js";

// 雨云 komari-agent tasks, 2026-11-20: one read-only look past its deadline left a task unable to look at anything.
describe("read-only commands", () => {
  it.each([
    "ls -la ~/.ssh",
    "cat /etc/os-release; uname -a",
    "ps aux | grep komari | head -5",
    "cd /opt/komari && ls -la && sha256sum komari-agent",
    "find / -name 'komari*' -type f 2>/dev/null",
    "stat /tmp/marker 2>/dev/null || echo missing",
    "systemctl status komari-agent --no-pager",
    "journalctl -u komari-agent -n 50 --no-pager 2>&1",
    "docker ps -a && docker logs --tail 50 komari",
    "docker compose -f /opt/a/compose.yaml ps",
    "git -C /repo log --oneline -5",
    "ip addr show eth0",
    "date -d yesterday +%F",
    'grep -r "server_url" /etc/komari # look for the endpoint',
    "test -f /etc/komari/config.json && echo yes",
    "command -v sshpass",
    "sort -n sizes.txt | uniq -c",
    "/usr/bin/ls -l < /dev/null",
  ])("reads only: %s", (command) => expect(readOnlyCommand(command)).toBe(true));

  it.each([
    "touch /tmp/marker",
    "ls > listing.txt",
    "echo ok >> log",
    "cat a | tee b",
    "ls; rm -rf /tmp/komari",
    "echo $(rm -rf /tmp/x)",
    "echo `id`",
    "(cd /tmp && ls)",
    "tail -f log &",
    "sftp -b - host <<< 'ls'",
    "cat <<EOF\nx\nEOF",
    "find . -name '*.tmp' -delete",
    "find . -exec rm {} \\;",
    "systemctl restart komari-agent",
    "docker compose up -d",
    "docker exec komari ls",
    "git -c core.pager=less log",
    "git push",
    "ip link set eth0 down",
    "date -s 10:00",
    "hostname new-name",
    "sort -o out.txt in.txt",
    "uniq in.txt out.txt",
    "env FOO=1 ls",
    "FOO=1 ls",
    "sudo ls /root",
    "curl -o page.html https://example.com",
    "ls 'unterminated",
    "",
  ])("is not read-only: %j", (command) => expect(readOnlyCommand(command)).toBe(false));

  it("counts a foreground read-only command as an observation, and nothing else", () => {
    expect(computerObservationAllowed("computer_exec", { command: "ls -la /tmp", timeoutMs: 10000, cwd: "/root" })).toBe(true);
    expect(computerObservationAllowed("computer_exec", { command: "ls -la /tmp", background: true })).toBe(false);
    expect(computerObservationAllowed("computer_exec", { command: "touch /tmp/x" })).toBe(false);
    expect(computerObservationAllowed("computer_exec", { command: "ls", stdin: "rm -rf /" })).toBe(false);
  });
});

describe("dangerous commands", () => {
  it.each([
    ["rm -rf /", "会递归删除系统目录或整个主目录"],
    ["sudo rm -rf /etc", "会递归删除系统目录或整个主目录"],
    ["rm -fr ~/*", "会递归删除系统目录或整个主目录"],
    ["rm -r --no-preserve-root /x", "会删除整个系统"],
    ["chown -R root /usr", "会递归改动系统目录或整个主目录的权限"],
    ["mkfs.ext4 /dev/vdb", "会改写磁盘分区或文件系统"],
    ["fdisk /dev/vda", "会改写磁盘分区或文件系统"],
    ["dd if=x.img of=/dev/vda bs=4M", "会直接写磁盘设备"],
    ["sudo shutdown -h now", "会关机或重启机器"],
    ["ssh root@203.0.113.7 'reboot'", "会关机或重启机器"],
    ["echo done && systemctl reboot", "会关机或重启机器"],
    ["echo key > ~/.ssh/authorized_keys", "会覆盖 SSH 登录密钥"],
    ["rm ~/.ssh/authorized_keys", "会删除或移走 SSH 登录密钥"],
    ["iptables -F", "可能把远程连接挡在防火墙外"],
    ["iptables -P INPUT DROP", "可能把远程连接挡在防火墙外"],
    ["ufw --force enable", "可能把远程连接挡在防火墙外"],
    ["crontab -r", "会删除全部定时任务"],
    ["userdel bob", "会删除系统账号"],
  ])("routes %j to the main conversation", (command, reason) => expect(dangerousCommand(command)).toBe(reason));

  it.each([
    "rm -rf /tmp/komari-agent-1.5.11 /tmp/venv",
    "rm -rf ~/komari-agent",
    "chmod 600 ~/.ssh/config",
    "cat > ~/.ssh/config <<'EOF'\nHost rainyun\nEOF",
    "echo key >> ~/.ssh/authorized_keys",
    "fdisk -l",
    "dd if=/dev/zero of=./swap bs=1M count=1",
    "systemctl restart komari-agent",
    "iptables -A INPUT -p tcp --dport 22 -j ACCEPT",
    "ufw allow 22/tcp",
    "journalctl -b -1 | grep -i reboot",
    "apt-get install -y sshpass",
  ])("lets a task run %j itself", (command) => expect(dangerousCommand(command)).toBeUndefined());
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const toolStep = (toolName: string, input: unknown, id: string) => ({
  stream: convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
  ] as never),
});

async function run(steps: { tool: string; input: unknown }[], options: { outcome?: unknown } = {}) {
  const path = await mkdtemp(join(tmpdir(), "yib-read-only-"));
  dirs.push(path);
  const executed: string[] = [];
  const prompts: string[] = [];
  const exec: AgentTool<{ command: string }> = {
    name: "computer_exec",
    description: "run a command",
    inputSchema: jsonSchema({ type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false }),
    // Every command runs past its deadline, as the device stopped answering.
    execute: async ({ command }) => (executed.push(command), options.outcome ?? { status: "unknown", code: "deadline_exceeded" }),
  };
  const browser: AgentTool<Record<string, unknown>> = {
    name: "computer_browser",
    description: "use the browser",
    inputSchema: jsonSchema({ type: "object", additionalProperties: true }),
    execute: async (input) => (executed.push(`browser ${String(input.action)}`), { status: "succeeded", output: { text: "page" } }),
  };
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const step = steps[prompts.length - 1]!;
      return toolStep(step.tool, step.input, `call-${prompts.length}`) as never;
    },
  });
  const manager = new Tasks(path, {
    prepare: async () => ({ config: { model, tools: [exec as AgentTool, browser as AgentTool] } }),
    notify: vi.fn(async () => "delivered" as const),
    diagnostic: vi.fn(),
    changed: () => {},
  });
  await manager.start();
  const task = await manager.create({ channel: "channel-a", session: "first.jsonl" }, "computer", "检查服务器", "key", [], {
    timeLimitMinutes: 30,
  });
  await vi.waitFor(async () => expect((await manager.store.get(task.id))?.notification).toBe("delivered"), { timeout: 30000 });
  const record = (await manager.store.get(task.id))!;
  await manager.stop();
  return { record, executed, prompts };
}

const report = { tool: "task_report", input: { status: "succeeded", result: "已核实" } };

it("does not lock a task whose read-only look came back unknown", async () => {
  const { record, executed } = await run([
    { tool: "computer_exec", input: { command: "ls -la /opt/komari" } },
    { tool: "computer_exec", input: { command: "systemctl restart komari-agent" } },
    report,
  ]);
  expect(executed).toEqual(["ls -la /opt/komari", "systemctl restart komari-agent"]);
  // The restart itself came back unknown, so the result still is.
  expect(record.status).toBe("unknown");
});

it("lets a task check with read-only commands after a write of unknown outcome, but not write again", async () => {
  const { record, executed, prompts } = await run([
    { tool: "computer_exec", input: { command: "touch /tmp/marker" } },
    { tool: "computer_exec", input: { command: "rm -f /tmp/marker" } },
    { tool: "computer_exec", input: { command: "stat /tmp/marker 2>/dev/null || echo missing" } },
    report,
  ]);
  expect(executed).toEqual(["touch /tmp/marker", "stat /tmp/marker 2>/dev/null || echo missing"]);
  expect(prompts[2]).toContain("execution_unknown");
  expect(prompts[2]).toContain("只读命令");
  expect(record).toMatchObject({ status: "unknown" });
  expect(record.result).toContain("存在结果未确认的工具操作");
});

it("keeps a task whose only unknown was a read-only look as reported", async () => {
  const { record } = await run([{ tool: "computer_exec", input: { command: "ls -la /opt/komari" } }, report]);
  expect(record).toMatchObject({ status: "succeeded", result: "已核实" });
});

const succeeded = { status: "succeeded", output: { exitCode: 0, stdout: "" } };

// User, 2026-11-22: 「后台不要真正去约束能够使用的工具，靠主agent的提示词去约束就好了」. A read-only task blocked
// `ssh` (task b9fe689f), so the main conversation ran the whole investigation itself; what a task may touch is now
// only said in its instruction.
it("does not hold a task to read-only commands by its tools", async () => {
  const { record, executed, prompts } = await run(
    [
      { tool: "computer_exec", input: { command: "ssh -J ssh2 root@127.0.0.1 'docker logs yesimbot-preview | tail -n 50'" } },
      { tool: "computer_exec", input: { command: "sed -n 1,20p /etc/hosts" } },
      { tool: "computer_browser", input: { action: "click", ref: "e14" } },
      report,
    ],
    { outcome: succeeded },
  );
  expect(record).toMatchObject({ status: "succeeded" });
  expect(record).not.toHaveProperty("readOnly");
  expect(executed).toEqual(["ssh -J ssh2 root@127.0.0.1 'docker logs yesimbot-preview | tail -n 50'", "sed -n 1,20p /etc/hosts", "browser click"]);
  for (const prompt of prompts) expect(prompt).not.toContain("read_only_task");
  expect(prompts[0]).not.toContain("这是只读任务");
});

it("leaves a command too hard to undo to the main conversation", async () => {
  const { record, executed, prompts } = await run(
    [
      { tool: "computer_exec", input: { command: "ssh root@203.0.113.7 'reboot'" } },
      { tool: "computer_exec", input: { command: "rm -rf /tmp/komari-agent-1.5.11" } },
      { tool: "task_report", input: { status: "waiting", result: "需要重启服务器：ssh root@203.0.113.7 'reboot'，让新内核生效" } },
    ],
    { outcome: succeeded },
  );
  expect(executed).toEqual(["rm -rf /tmp/komari-agent-1.5.11"]);
  expect(prompts[1]).toContain("dangerous_command");
  expect(prompts[1]).toContain("会关机或重启机器");
  expect(record).toMatchObject({ status: "waiting" });
  expect(record.handoff).toBeUndefined();
});
