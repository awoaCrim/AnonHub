import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeviceInvocation, OperationResult } from "@yesimbot/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { validateClientConfig } from "../src/config.js";
import { initialClientConfig } from "../src/controller.js";
import { LocalFilesDriver } from "../src/drivers/files.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup() {
  // realpath: macOS's /var is a link to /private/var.
  const base = await realpath(await mkdtemp(join(tmpdir(), "project-files-")));
  directories.push(base);
  const project = join(base, "project"),
    outside = join(base, "outside");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(project, "src", "app.ts"), "const a = 1;\n");
  await writeFile(join(outside, "secret.txt"), "secret\n");
  const files = new LocalFilesDriver(join(base, "workspaces"), [project]);
  const run = (method: string, input: Record<string, unknown>): Promise<OperationResult> =>
    files.methods[method]!.execute(call(method, input), new AbortController().signal);
  return { base, project, outside, run };
}

function call(method: string, input: Record<string, unknown>): DeviceInvocation {
  return {
    operationId: randomUUID(),
    capability: "workspace.files",
    method,
    expiresAt: Date.now() + 30_000,
    conversation: { tenantId: "11111111-1111-4111-8111-111111111111", botId: "bot", platform: "test", kind: "direct", conversationId: "me" },
    actors: [{ platform: "test", userId: "me" }],
    input,
  };
}

const data = (text: string) => Buffer.from(text).toString("base64");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe.skipIf(process.platform === "win32")("project directories on the device", () => {
  it("reads, lists, writes and creates directories by absolute path inside a project directory", async () => {
    const { project, run } = await setup();
    await expect(run("read", { path: join(project, "src", "app.ts") })).resolves.toMatchObject({
      status: "succeeded",
      output: { data: data("const a = 1;\n") },
    });
    await expect(run("list", { path: join(project, "src") })).resolves.toEqual({ status: "succeeded", output: [{ name: "app.ts", directory: false }] });
    // Missing parents are created inside the project.
    await expect(run("write", { path: join(project, "docs", "new", "notes.md"), data: data("# notes\n") })).resolves.toMatchObject({ status: "succeeded" });
    expect(await readFile(join(project, "docs", "new", "notes.md"), "utf8")).toBe("# notes\n");
    await expect(run("mkdir", { path: join(project, "a", "b") })).resolves.toMatchObject({ status: "succeeded" });
    expect((await stat(join(project, "a", "b"))).isDirectory()).toBe(true);
  });

  it("refuses paths outside every project directory, through .. or through a link", async () => {
    const { project, outside, run } = await setup();
    for (const path of [join(outside, "secret.txt"), join(project, "..", "outside", "secret.txt"), "/etc/hosts"])
      await expect(run("read", { path })).resolves.toEqual({ status: "rejected", code: "path_outside_roots" });
    await symlink(join(outside, "secret.txt"), join(project, "leak.txt"));
    await symlink(outside, join(project, "out"));
    await expect(run("read", { path: join(project, "leak.txt") })).resolves.toEqual({ status: "rejected", code: "path_outside_roots" });
    await expect(run("write", { path: join(project, "out", "planted.txt"), data: data("x") })).resolves.toEqual({
      status: "rejected",
      code: "path_outside_roots",
    });
    await expect(run("write", { path: project, data: data("x") })).resolves.toEqual({ status: "rejected", code: "workspace_root_immutable" });
    // A link that stays inside the project is followed.
    await symlink(join(project, "src", "app.ts"), join(project, "alias.ts"));
    await expect(run("read", { path: join(project, "alias.ts") })).resolves.toMatchObject({ status: "succeeded" });
  });

  it("replaces a file only while it still has the expected content, and never one that exists when none was expected", async () => {
    const { project, run } = await setup();
    const path = join(project, "src", "app.ts");
    await expect(run("write", { path, data: data("x\n"), expectedSha256: sha256("something else") })).resolves.toEqual({
      status: "rejected",
      code: "file_changed",
    });
    await expect(run("write", { path, data: data("x\n"), expectedSha256: null })).resolves.toEqual({ status: "rejected", code: "file_exists" });
    expect(await readFile(path, "utf8")).toBe("const a = 1;\n");
    await expect(run("write", { path, data: data("const a = 2;\n"), expectedSha256: sha256("const a = 1;\n") })).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(await readFile(path, "utf8")).toBe("const a = 2;\n");
    await expect(run("write", { path: join(project, "fresh.ts"), data: data("y\n"), expectedSha256: null })).resolves.toMatchObject({ status: "succeeded" });
    await expect(run("write", { path: join(project, "gone.ts"), data: data("y\n"), expectedSha256: sha256("y\n") })).resolves.toEqual({
      status: "rejected",
      code: "file_changed",
    });
  });

  it("keeps an existing file's permissions and refuses to split a hard-linked file", async () => {
    const { project, run } = await setup();
    const script = join(project, "run.sh");
    await writeFile(script, "#!/bin/sh\necho old\n");
    await chmod(script, 0o755);
    await expect(run("write", { path: script, data: data("#!/bin/sh\necho new\n") })).resolves.toMatchObject({ status: "succeeded" });
    expect((await stat(script)).mode & 0o777).toBe(0o755);
    await link(script, join(project, "run-copy.sh"));
    await expect(run("write", { path: script, data: data("x") })).resolves.toEqual({ status: "rejected", code: "file_hardlinked" });
  });

  it("reports a missing file as not found, and a missing project directory as unavailable", async () => {
    const { base, project, run } = await setup();
    await expect(run("read", { path: join(project, "nope.ts") })).resolves.toEqual({ status: "failed", code: "file_not_found" });
    const gone = new LocalFilesDriver(join(base, "workspaces"), [join(base, "deleted")]);
    await expect(gone.methods.read!.execute(call("read", { path: join(base, "deleted", "a.ts") }), new AbortController().signal)).resolves.toEqual({
      status: "rejected",
      code: "project_root_unavailable",
    });
  });

  it("keeps relative paths in the conversation's own directory", async () => {
    const { project, run } = await setup();
    await expect(run("write", { path: "note.txt", data: data("mine\n") })).resolves.toMatchObject({ status: "succeeded" });
    await expect(run("read", { path: "note.txt" })).resolves.toMatchObject({ status: "succeeded", output: { data: data("mine\n") } });
    await expect(run("read", { path: "../project/src/app.ts" })).resolves.toEqual({ status: "rejected", code: "invalid_file_input" });
    await expect(run("read", { path: join(project, "note.txt") })).resolves.toEqual({ status: "failed", code: "file_not_found" });
  });
});

it("accepts only absolute project directories in the client's settings", () => {
  const config = (projectRoots: string[]) => ({
    ...initialClientConfig(),
    gateway: "https://devices.example.com",
    capabilities: { files: true, projectRoots },
  });
  expect(validateClientConfig(config(["/srv/app"])).capabilities.projectRoots).toEqual(["/srv/app"]);
  expect(() => validateClientConfig(config(["relative/app"]))).toThrow();
});
