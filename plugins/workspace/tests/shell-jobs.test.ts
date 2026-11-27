import { EphemeralImageProjectionStore, type AgentTool } from "@yesimbot/agent-runtime";
import { describe, expect, it, vi } from "vitest";

import { ComputerActivity } from "../../../core/src/computer-activity.js";
import { createWorkspaceComputerTools } from "../src/computer.js";

const DEVICE = "33333333-3333-4333-8333-333333333333";

function setup(
  features: string[] | "list-fails",
  reply: (input: { method: string; input: Record<string, unknown> }) => unknown = () => ({ status: "succeeded", output: {} }),
) {
  const invoke = vi.fn(async (_deviceId: string, invocation: { method: string; input: Record<string, unknown>; expiresAt: number }) => reply(invocation));
  const list = vi.fn(async () => {
    if (features === "list-fails") throw new Error("gateway_unavailable");
    return [{ deviceId: DEVICE, capabilities: ["computer.shell"], features }];
  });
  const tools = createWorkspaceComputerTools(
    { invoke, list, activity: new ComputerActivity() } as never,
    { platform: "web", channelId: "c", type: "direct" } as never,
    { deviceId: DEVICE },
    new EphemeralImageProjectionStore(),
    (name) => name === "computer_exec",
  );
  const tool = (name: string) => tools.find((candidate) => candidate.name === name) as AgentTool;
  return { invoke, tool, names: tools.map((candidate) => candidate.name) };
}

let calls = 0;
const execution = () => ({ runtime: { id: "r" }, turnId: "t", toolCallId: `call-${++calls}`, messages: [] }) as never;

describe("computer_exec with background jobs", () => {
  it("offers computer_job together with computer_exec", () => {
    expect(setup(["shell-jobs"]).names).toEqual(["computer_exec", "computer_job"]);
  });

  it("asks a client that announces shell-jobs to keep a command past its wait, and explains the job it became", async () => {
    const { invoke, tool } = setup(["shell-jobs"], () => ({ status: "succeeded", output: { running: true, jobId: "job-1", stdout: "partial" } }));
    const before = Date.now();
    const result = await tool("computer_exec").execute!({ command: "yarn build", timeoutMs: 5000 }, execution());
    const [, invocation] = invoke.mock.calls[0]!;
    expect(invocation).toMatchObject({ method: "exec", input: { command: "yarn build", timeoutMs: 5000, continueAfterTimeout: true } });
    // The client stops waiting first; the deadline leaves it a margin.
    expect(invocation.expiresAt).toBeGreaterThanOrEqual(before + 20_000);
    expect(result).toMatchObject({ status: "succeeded", message: expect.stringContaining("computer_job"), output: { running: true, jobId: "job-1" } });
  });

  it("starts a background command with only the command and cwd", async () => {
    const { invoke, tool } = setup(["shell-jobs"], () => ({ status: "succeeded", output: { jobId: "job-2", state: "running" } }));
    const result = await tool("computer_exec").execute!({ command: "yarn install", cwd: "/repo", timeoutMs: 9000, background: true }, execution());
    expect(invoke.mock.calls[0]![1]).toMatchObject({ method: "start", input: { command: "yarn install", cwd: "/repo" } });
    expect(Object.keys(invoke.mock.calls[0]![1].input).sort()).toEqual(["command", "cwd"]);
    expect(result).toMatchObject({ message: expect.stringContaining("job-2") });
  });

  it("sends an older client only the fields it accepts, and refuses background work without reaching it", async () => {
    for (const features of [[], "list-fails"] as const) {
      const { invoke, tool } = setup(features as string[] | "list-fails");
      await tool("computer_exec").execute!({ command: "pwd", background: false }, execution());
      expect(invoke.mock.calls[0]![1]).toMatchObject({ method: "exec", input: { command: "pwd" } });
      expect(Object.keys(invoke.mock.calls[0]![1].input)).toEqual(["command"]);
      await expect(tool("computer_exec").execute!({ command: "yarn build", background: true }, execution())).resolves.toMatchObject({
        status: "rejected",
        code: "client_update_required",
      });
      await expect(tool("computer_job").execute!({ action: "list" }, execution())).resolves.toMatchObject({ code: "client_update_required" });
      expect(invoke).toHaveBeenCalledTimes(1);
    }
  });

  it("explains a command stopped at its timeout, by an older client or a newer one", async () => {
    const old = setup([], () => ({ status: "unknown", code: "shell_interrupted" }));
    await expect(old.tool("computer_exec").execute!({ command: "sleep 99" }, execution())).resolves.toMatchObject({
      status: "unknown",
      code: "shell_interrupted",
      message: expect.stringContaining("先检查当前状态"),
    });
    // Pipeline audit, 2026-11-20: on such a client installs and downloads were cut off, planned as if they kept running.
    const told = (await old.tool("computer_exec").execute!({ command: "pip install paramiko" }, execution())) as { message: string };
    expect(told.message).toContain("这台电脑的客户端不支持后台命令");
    expect(told.message).toContain("curl --max-time、pip --timeout");
    const newer = setup(["shell-jobs"], () => ({ status: "succeeded", output: { exitCode: null, timedOut: true, backgroundUnavailable: "shell_jobs_busy" } }));
    await expect(newer.tool("computer_exec").execute!({ command: "sleep 99" }, execution())).resolves.toMatchObject({
      status: "succeeded",
      message: expect.stringContaining("可能已经部分执行"),
      output: { timedOut: true },
    });
    const newerMessage = ((await newer.tool("computer_exec").execute!({ command: "sleep 99" }, execution())) as { message: string }).message;
    expect(newerMessage).toContain("background: true");
    expect(newerMessage).not.toContain("不支持后台命令");
  });

  it("does not promise that a command outlives its wait on every client", () => {
    const { tool } = setup([]);
    const description = tool("computer_exec").description!;
    expect(description).not.toContain("到时还没结束的命令不会被终止");
    expect(description).toContain("较旧的客户端不支持后台命令");
  });
});

describe("computer_job", () => {
  it("maps read, stop and list onto the client's job method", async () => {
    const { invoke, tool } = setup(["shell-jobs"]);
    const id = "44444444-4444-4444-8444-444444444444";
    await tool("computer_job").execute!({ action: "read", jobId: id, waitMs: 90_000, offset: 10 }, execution());
    await tool("computer_job").execute!({ action: "stop", jobId: id, waitMs: 5 }, execution());
    await tool("computer_job").execute!({ action: "list" }, execution());
    expect(invoke.mock.calls.map(([, invocation]) => [invocation.method, invocation.input])).toEqual([
      ["job", { action: "read", id, waitMs: 90_000, offset: 10 }],
      ["job", { action: "stop", id }],
      ["job", { action: "list" }],
    ]);
    // Waiting reads get a deadline beyond their wait.
    expect(invoke.mock.calls[0]![1].expiresAt - Date.now()).toBeGreaterThan(100_000);
  });

  it("asks for a job ID before reaching the computer, and explains a job that is gone", async () => {
    const { invoke, tool } = setup(["shell-jobs"], () => ({ status: "rejected", code: "shell_job_not_found" }));
    await expect(tool("computer_job").execute!({ action: "read" }, execution())).resolves.toMatchObject({ code: "invalid_job_input" });
    expect(invoke).not.toHaveBeenCalled();
    await expect(tool("computer_job").execute!({ action: "read", jobId: "44444444-4444-4444-8444-444444444444" }, execution())).resolves.toMatchObject({
      code: "shell_job_not_found",
      message: expect.stringContaining("客户端重启"),
    });
  });
});
