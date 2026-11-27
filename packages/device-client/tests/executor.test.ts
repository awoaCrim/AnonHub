import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workspaceOwnerKey, type DeviceCredential, type DeviceInvocation, type ToolPolicy } from "@yesimbot/contracts";
import { bindDeviceDirectory, OperationStore, ResourceBindings } from "@yesimbot/device-store";
import { afterEach, expect, it, vi } from "vitest";

import { CONVERSATION_LABEL, LocalFilesDriver } from "../src/drivers/files.js";
import { LocalShellDriver } from "../src/drivers/shell.js";
import { DeviceExecutor } from "../src/executor.js";

const tenant = "11111111-1111-4111-8111-111111111111",
  device = "22222222-2222-4222-8222-222222222222";
const credential: DeviceCredential = { version: 1, tenantId: tenant, deviceId: device, secret: "a".repeat(64) };
const policy: ToolPolicy = {
  version: 1,
  direct: { enabled: true, tools: ["*"] },
  group: { enabled: true, tools: ["*"] },
  actors: [{ kind: "any", platform: "test", conversationId: "*", userId: "allowed" }],
};
const directories: string[] = [],
  executors: DeviceExecutor[] = [];
afterEach(async () => {
  for (const executor of executors.splice(0)) await executor.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function temp() {
  const directory = await mkdtemp(join(tmpdir(), "device-executor-"));
  directories.push(directory);
  return directory;
}

function invocation(extra: Partial<DeviceInvocation> = {}): DeviceInvocation {
  return {
    operationId: randomUUID(),
    capability: "computer.shell",
    method: "exec",
    expiresAt: Date.now() + 30_000,
    conversation: { tenantId: tenant, botId: "bot", platform: "test", kind: "direct", conversationId: "allowed" },
    actors: [{ platform: "test", userId: "allowed" }],
    input: { command: "printf test" },
    ...extra,
  };
}

it("does not execute an interrupted operation again after its durable journal is reopened", async () => {
  const directory = await temp(),
    execute = vi.fn(async () => {
      throw new Error("interrupted");
    });
  const drivers = [{ capability: "computer.shell" as const, methods: { exec: { contexts: ["direct" as const], execute } } }];
  const first = new DeviceExecutor(credential, drivers, await OperationStore.open(directory), policy);
  const request = invocation();
  expect(await first.execute(request)).toMatchObject({ status: "unknown" });
  await first.close();
  const second = new DeviceExecutor(credential, drivers, await OperationStore.open(directory), policy);
  executors.push(second);
  expect(await second.execute(request)).toMatchObject({ status: "unknown" });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await second.execute({ ...request, input: { command: "different" } })).toMatchObject({ status: "rejected", code: "operation_id_conflict" });
});

it("rejects a foreign identity, actor-less or mixed batch, and expired commands before native execution", async () => {
  const execute = vi.fn(async () => ({ status: "succeeded" as const, output: {} }));
  const executor = new DeviceExecutor(
    credential,
    [{ capability: "computer.shell", methods: { exec: { contexts: ["direct", "group"], execute } } }],
    await OperationStore.open(await temp()),
    policy,
  );
  executors.push(executor);
  const request = invocation();
  // Sender limits apply to group chats; private chats are gated by the bot's channel allowlist.
  const group = { ...request.conversation, kind: "group" as const, conversationId: "room" };
  for (const input of [
    invocation({ conversation: group, actors: [] }),
    invocation({ conversation: group, actors: [...request.actors, { platform: "test", userId: "denied" }] }),
    invocation({ expiresAt: 1 }),
    invocation({ conversation: { ...request.conversation, tenantId: randomUUID() } }),
  ])
    expect(await executor.execute(input)).toMatchObject({ status: "rejected" });
  expect(execute).not.toHaveBeenCalled();
});

it("no longer refuses a sensitive group operation by itself; the device's own local consent still decides", async () => {
  const directory = await temp();
  const execute = vi.fn(async () => ({ status: "succeeded" as const }));
  const driver = { capability: "computer.shell" as const, methods: { exec: { contexts: ["direct" as const, "group" as const], execute } } };
  const executor = new DeviceExecutor(credential, [driver], await OperationStore.open(directory), policy);
  executors.push(executor);
  const request = invocation();
  expect(await executor.execute({ ...request, conversation: { ...request.conversation, kind: "group" } })).toEqual({ status: "succeeded" });
  expect(execute).toHaveBeenCalledOnce();

  // A device whose owner left group chats off still refuses the same call.
  const closedExecute = vi.fn(async () => ({ status: "succeeded" as const }));
  const closed = new DeviceExecutor(
    credential,
    [{ capability: "computer.shell" as const, methods: { exec: { contexts: ["direct" as const, "group" as const], execute: closedExecute } } }],
    await OperationStore.open(await temp()),
    { ...policy, group: { enabled: false, tools: [] } },
  );
  executors.push(closed);
  expect(await closed.execute({ ...request, conversation: { ...request.conversation, kind: "group" } })).toEqual({ status: "rejected", code: "policy_denied" });
  expect(closedExecute).not.toHaveBeenCalled();
});

it("binds local state to one device and binds private media tokens to their originating conversation", async () => {
  const directory = await temp();
  await bindDeviceDirectory(directory, credential);
  await expect(bindDeviceDirectory(directory, { ...credential, tenantId: randomUUID() })).rejects.toThrow("device_directory_binding_mismatch");
  const resources = await ResourceBindings.open(directory);
  try {
    resources.bind("image", ["bot", "direct", "allowed"]);
    expect(resources.allows("image", ["bot", "group", "allowed"])).toBe(false);
    expect(resources.allows("image", ["other-bot", "direct", "allowed"])).toBe(false);
    expect(resources.allows("image", ["bot", "direct", "allowed"])).toBe(true);
  } finally {
    resources.close();
  }
});

it("isolates device files by conversation and rejects traversal and symlink reads", async () => {
  const root = await temp(),
    files = new LocalFilesDriver(root),
    signal = new AbortController().signal;
  const first = invocation({ capability: "workspace.files", method: "write", input: { path: "private.txt", data: Buffer.from("private").toString("base64") } });
  expect(await files.methods.write!.execute(first, signal)).toMatchObject({ status: "succeeded" });
  expect(await files.methods.read!.execute({ ...first, input: { path: "private.txt" } }, signal)).toMatchObject({
    status: "succeeded",
    output: { data: Buffer.from("private").toString("base64") },
  });
  // Another conversation does not see the file: for it, it does not exist.
  await expect(
    files.methods.read!.execute({ ...first, conversation: { ...first.conversation, kind: "group" }, input: { path: "private.txt" } }, signal),
  ).resolves.toEqual({ status: "failed", code: "file_not_found" });
  for (const path of ["../private.txt", "/etc/passwd", "C:\\private.txt", "a/../../private.txt", "CON", "test:stream"])
    expect(await files.methods.read!.execute({ ...first, input: { path } }, signal)).toMatchObject({ status: "rejected" });
  const directory = createHash("sha256")
    .update(workspaceOwnerKey({ kind: "conversation", conversation: first.conversation }))
    .digest("hex");
  await writeFile(join(root, "outside.txt"), "outside");
  await symlink(join(root, "outside.txt"), join(root, directory!, "link.txt"));
  await expect(files.methods.read!.execute({ ...first, input: { path: "link.txt" } }, signal)).rejects.toThrow("workspace_link_denied");
});

it("labels each conversation directory once with whose it is, for files and the shell alike", async () => {
  const root = await temp(),
    files = new LocalFilesDriver(root),
    signal = new AbortController().signal;
  const group = invocation({ capability: "workspace.files", method: "list", input: { path: "" } });
  const conversation = { ...group.conversation, kind: "group" as const, conversationId: "100200300" };
  const directory = join(
    root,
    createHash("sha256")
      .update(workspaceOwnerKey({ kind: "conversation", conversation }))
      .digest("hex"),
  );
  expect(await files.methods.list!.execute({ ...group, conversation }, signal)).toMatchObject({
    status: "succeeded",
    output: [{ name: CONVERSATION_LABEL, directory: false }],
  });
  expect(JSON.parse(await readFile(join(directory, CONVERSATION_LABEL), "utf8"))).toEqual({
    platform: "test",
    kind: "group",
    conversationId: "100200300",
    botId: "bot",
  });
  // An edited label is never rewritten.
  await writeFile(join(directory, CONVERSATION_LABEL), "edited");
  await files.methods.list!.execute({ ...group, conversation }, signal);
  expect(await readFile(join(directory, CONVERSATION_LABEL), "utf8")).toBe("edited");
  // The shell starts in the same labelled directory.
  const shell = new LocalShellDriver(root, true);
  try {
    const other = { ...conversation, conversationId: "private:alice" };
    const command = process.platform === "win32" ? "Get-Content .conversation.json" : "cat .conversation.json";
    const result = await shell.methods.exec!.execute(invocation({ conversation: other, input: { command } }), signal);
    expect(result).toMatchObject({ status: "succeeded", output: { exitCode: 0, stdout: expect.stringContaining('"conversationId": "private:alice"') } });
  } finally {
    await shell.close();
  }
});

it("executes a bounded local shell command with the explicit workspace as cwd", async () => {
  const root = await temp(),
    shell = new LocalShellDriver(root),
    signal = new AbortController().signal;
  try {
    const request = invocation({ input: { command: process.platform === "win32" ? "Write-Output local-test" : "printf local-test" } });
    expect(await shell.methods.exec!.execute(request, signal)).toMatchObject({
      status: "succeeded",
      output: { exitCode: 0, stdout: expect.stringContaining("local-test") },
    });
  } finally {
    await shell.close();
  }
});

it("never journals a screen-view read, yet keeps policy, cancellation and ID-conflict checks", async () => {
  const directory = await temp();
  const store = await OperationStore.open(directory);
  let release!: () => void;
  const execute = vi.fn(
    (_invocation: DeviceInvocation, signal: AbortSignal) =>
      new Promise<{ status: "succeeded"; output: unknown }>((resolve, reject) => {
        release = () => resolve({ status: "succeeded", output: { data: "image" } });
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
  const desktop = [{ capability: "computer.desktop" as const, methods: { execute: { contexts: ["direct" as const], execute } } }];
  const viewer = (enabled: boolean): ToolPolicy => ({
    ...policy,
    platforms: { "yesimbot-viewer": { direct: { enabled, tools: ["computer.desktop.execute"] }, group: { enabled: false, tools: [] }, actors: [] } },
  });
  const viewerPolicy = viewer(true);
  const executor = new DeviceExecutor(credential, desktop, store, viewerPolicy);
  executors.push(executor);
  const view = (operationId = randomUUID()): DeviceInvocation => ({
    operationId,
    capability: "computer.desktop",
    method: "execute",
    input: { actions: [] },
    conversation: { tenantId: tenant, botId: "webui", platform: "yesimbot-viewer", kind: "direct", conversationId: "screen" },
    actors: [],
    expiresAt: Date.now() + 10_000,
  });
  const first = view();
  const pending = executor.execute(first);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  // Same ID while running, and an ID already held by a journaled operation, are both refused.
  expect(await executor.execute(first)).toEqual({ status: "rejected", code: "operation_id_conflict" });
  release();
  expect(await pending).toMatchObject({ status: "succeeded" });
  expect(store.get(first.operationId)).toBeUndefined();
  expect(executor.status(first.operationId)).toEqual({ status: "unknown", code: "operation_not_seen" });

  const cancelled = view();
  const running = executor.execute(cancelled);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  executor.cancel(cancelled.operationId);
  expect(await running).toEqual({ status: "unknown", code: "execution_interrupted" });
  expect(store.get(cancelled.operationId)).toBeUndefined();

  const journaled = { ...view(), input: { actions: [{ type: "screenshot" }] } };
  const effect = executor.execute(journaled);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
  release();
  expect(await effect).toMatchObject({ status: "succeeded" });
  expect(store.get(journaled.operationId)?.result).toMatchObject({ status: "succeeded" });
  expect(await executor.execute(view(journaled.operationId))).toEqual({ status: "rejected", code: "operation_id_conflict" });

  // The viewer scope still goes through the client's own local policy.
  const denied = new DeviceExecutor(credential, desktop, await OperationStore.open(await temp()), viewer(false));
  executors.push(denied);
  expect(await denied.execute(view())).toEqual({ status: "rejected", code: "policy_denied" });
  expect(execute).toHaveBeenCalledTimes(3);
});

it("writes the advertised 8 MiB upload limit without a regex stack overflow", async () => {
  const files = new LocalFilesDriver(await temp()),
    signal = new AbortController().signal;
  const data = Buffer.alloc(8 * 1024 * 1024, 1).toString("base64");
  const request = invocation({ capability: "workspace.files", method: "write", input: { path: "large.bin", data } });
  expect(await files.methods.write!.execute(request, signal)).toMatchObject({ status: "succeeded", output: { bytes: 8 * 1024 * 1024 } });
  expect(await files.methods.read!.execute({ ...request, input: { path: "large.bin" } }, signal)).toMatchObject({ status: "succeeded", output: { data } });
  for (const value of ["YQ", "YQ===", "YQ==\n", "YR=="])
    expect(await files.methods.write!.execute({ ...request, input: { path: "bad.bin", data: value } }, signal)).toMatchObject({
      status: "rejected",
      code: "invalid_file_data",
    });
});
