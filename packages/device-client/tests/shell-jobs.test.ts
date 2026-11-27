import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeviceCredential, DeviceInvocation, OperationResult, ToolPolicy } from "@yesimbot/contracts";
import { OperationStore } from "@yesimbot/device-store";
import { afterEach, describe, expect, it } from "vitest";

import { DEADLINE_REASON } from "../src/driver.js";
import { LocalShellDriver } from "../src/drivers/shell.js";
import { DeviceExecutor } from "../src/executor.js";

const tenant = "11111111-1111-4111-8111-111111111111";
const conversation = { tenantId: tenant, botId: "bot", platform: "test", kind: "direct" as const, conversationId: "allowed" };
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function driver() {
  const root = await mkdtemp(join(tmpdir(), "shell-jobs-"));
  const shell = new LocalShellDriver(root);
  cleanups.push(
    () => rm(root, { recursive: true, force: true }),
    () => shell.close(),
  );
  return { shell, root };
}

function call(method: string, input: unknown, extra: Partial<DeviceInvocation> = {}): DeviceInvocation {
  return {
    operationId: randomUUID(),
    capability: "computer.shell",
    method,
    expiresAt: Date.now() + 60_000,
    conversation,
    actors: [{ platform: "test", userId: "allowed" }],
    input,
    ...extra,
  };
}

function output(result: OperationResult): Record<string, unknown> {
  expect(result.status).toBe("succeeded");
  return (result as { output: Record<string, unknown> }).output;
}

const live = () => new AbortController().signal;

// The commands are POSIX shell; the Windows driver runs PowerShell.
describe.skipIf(process.platform === "win32")("local shell driver", () => {
  it("reports a command stopped at its timeout as a known result with its partial output", async () => {
    const { shell } = await driver();
    const result = output(await shell.methods.exec!.execute(call("exec", { command: "echo started; sleep 5; echo never", timeoutMs: 1000 }), live()));
    expect(result).toMatchObject({ exitCode: null, signal: "SIGKILL", timedOut: true, stdout: "started\n" });
    expect(result).not.toHaveProperty("running");
  });

  it("keeps a command running as a background job past its timeout when asked, and reads it to the end", async () => {
    const { shell } = await driver();
    const first = output(
      await shell.methods.exec!.execute(call("exec", { command: "echo one; sleep 1.5; echo two", timeoutMs: 1000, continueAfterTimeout: true }), live()),
    );
    expect(first).toMatchObject({ running: true, stdout: "one\n" });
    const jobId = first.jobId as string;

    const done = output(await shell.methods.job!.execute(call("job", { action: "read", id: jobId, waitMs: 10_000 }), live()));
    // Only what was not already returned by exec.
    expect(done).toMatchObject({ jobId, state: "exited", exitCode: 0, output: "two\n", omittedBytes: 0 });
    const list = output(await shell.methods.job!.execute(call("job", { action: "list" }), live()));
    expect(list.jobs).toEqual([expect.objectContaining({ jobId, state: "exited", exitCode: 0, command: "echo one; sleep 1.5; echo two" })]);
  });

  it("does not kill a command for printing a lot; the middle of the output is dropped instead", async () => {
    const { shell } = await driver();
    const command = `i=0; while [ $i -lt 6000 ]; do printf '%0100d\\n' $i; i=$((i+1)); done; echo last-line`;
    const result = output(await shell.methods.exec!.execute(call("exec", { command, timeoutMs: 30_000 }), live()));
    expect(result).toMatchObject({ exitCode: 0, truncated: true });
    expect(result.stdout).toMatch(/^0{100}\n/);
    expect(result.stdout).toMatch(/\[… \d+ bytes omitted …\]/);
    expect(result.stdout).toMatch(/last-line\n$/);
  });

  it("starts a background job, shows only new output on each read, and stops it", async () => {
    const { shell } = await driver();
    const started = output(await shell.methods.start!.execute(call("start", { command: "echo ready; while true; do echo tick; sleep 0.2; done" }), live()));
    expect(started).toMatchObject({ state: "running", output: expect.stringContaining("ready\n") });
    const jobId = started.jobId as string;

    const read = output(await shell.methods.job!.execute(call("job", { action: "read", id: jobId, waitMs: 600 }), live()));
    expect(read.state).toBe("running");
    expect(read.output).toMatch(/^tick\n/);
    expect(read.output).not.toContain("ready");

    const stopped = output(await shell.methods.job!.execute(call("job", { action: "stop", id: jobId }), live()));
    expect(stopped).toMatchObject({ jobId, state: "stopped", stopReason: "stopped", exitCode: null });
  });

  it("reads earlier output again by offset without moving what counts as new", async () => {
    const { shell } = await driver();
    const started = output(await shell.methods.start!.execute(call("start", { command: "printf 'abcdef'" }), live()));
    const jobId = started.jobId as string;
    const again = output(await shell.methods.job!.execute(call("job", { action: "read", id: jobId, offset: 2, limit: 3 }), live()));
    expect(again).toMatchObject({ output: "cde", outputFrom: 2, outputTo: 5 });
    const fresh = output(await shell.methods.job!.execute(call("job", { action: "read", id: jobId }), live()));
    expect(fresh.output).toBe("");
  });

  it("never shows or stops one conversation's job to another", async () => {
    const { shell } = await driver();
    const started = output(await shell.methods.start!.execute(call("start", { command: "sleep 30" }), live()));
    const jobId = started.jobId as string;
    const other = { conversation: { ...conversation, conversationId: "someone-else" } };
    await expect(shell.methods.job!.execute(call("job", { action: "read", id: jobId }, other), live())).resolves.toEqual({
      status: "rejected",
      code: "shell_job_not_found",
    });
    await expect(shell.methods.job!.execute(call("job", { action: "stop", id: jobId }, other), live())).resolves.toEqual({
      status: "rejected",
      code: "shell_job_not_found",
    });
    expect(output(await shell.methods.job!.execute(call("job", { action: "list" }, other), live())).jobs).toEqual([]);
    expect(output(await shell.methods.job!.execute(call("job", { action: "read", id: jobId }), live())).state).toBe("running");
  });

  it("treats a passed invocation deadline as the timeout, and a cancellation as stopping the command", async () => {
    const { shell } = await driver();
    const deadline = new AbortController();
    const pending = shell.methods.exec!.execute(call("exec", { command: "sleep 30", timeoutMs: 60_000, continueAfterTimeout: true }), deadline.signal);
    setTimeout(() => deadline.abort(DEADLINE_REASON), 300);
    expect(output(await pending)).toMatchObject({ running: true });

    const cancel = new AbortController();
    const cancelled = shell.methods.exec!.execute(call("exec", { command: "sleep 30", timeoutMs: 60_000, continueAfterTimeout: true }), cancel.signal);
    setTimeout(() => cancel.abort("cancelled"), 300);
    expect(output(await cancelled)).toMatchObject({ exitCode: null, stopped: "cancelled" });
  });

  it("reports a command that cannot start, and stops every job when the client closes", async () => {
    const { shell, root } = await driver();
    await expect(shell.methods.exec!.execute(call("exec", { command: "true", cwd: join(root, "missing") }), live())).resolves.toEqual({
      status: "failed",
      code: "shell_start_failed",
    });
    const started = output(await shell.methods.start!.execute(call("start", { command: "sleep 30" }), live()));
    await shell.close();
    const after = output(await shell.methods.job!.execute(call("job", { action: "read", id: started.jobId as string }), live()));
    expect(after).toMatchObject({ state: "stopped", stopReason: "shutdown" });
    await expect(shell.methods.start!.execute(call("start", { command: "true" }), live())).resolves.toEqual({ status: "rejected", code: "shell_unavailable" });
  });
});

describe("device executor grants for shell jobs", () => {
  const credential: DeviceCredential = { version: 1, tenantId: tenant, deviceId: "22222222-2222-4222-8222-222222222222", secret: "a".repeat(64) };
  const policy = (tools: string[]): ToolPolicy => ({
    version: 1,
    direct: { enabled: true, tools },
    group: { enabled: false, tools: [] },
    actors: [{ kind: "any", platform: "test", conversationId: "*", userId: "allowed" }],
  });
  const methods = { exec: true, start: true, job: true };
  const fakeShell = {
    capability: "computer.shell" as const,
    methods: Object.fromEntries(
      Object.keys(methods).map((name) => [
        name,
        { contexts: ["direct" as const], ...(name === "exec" ? {} : { grant: "exec" }), execute: async () => ({ status: "succeeded" as const, output: name }) },
      ]),
    ),
  };

  async function executor(tools: string[]) {
    const directory = await mkdtemp(join(tmpdir(), "shell-grants-"));
    const store = await OperationStore.open(directory);
    const device = new DeviceExecutor(credential, [fakeShell], store, policy(tools));
    cleanups.push(
      () => rm(directory, { recursive: true, force: true }),
      () => device.close(),
    );
    return device;
  }

  it("runs start and job under the exec grant, and refuses them without it", async () => {
    const granted = await executor(["computer.shell.exec"]);
    for (const method of ["start", "job"]) await expect(granted.execute(call(method, {}))).resolves.toEqual({ status: "succeeded", output: method });
    const denied = await executor(["workspace.files.read"]);
    for (const method of ["exec", "start", "job"])
      await expect(denied.execute(call(method, {}))).resolves.toEqual({ status: "rejected", code: "policy_denied" });
  });
});
