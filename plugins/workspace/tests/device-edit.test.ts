import { createHash } from "node:crypto";

import type { AgentTool, AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import type { ChannelContext, Devices } from "koishi-plugin-yesimbot";
import { describe, expect, it } from "vitest";

import { createDeviceEditTool, createDeviceFileTools, DeviceFileState, projectFilesPrompt } from "../src/device-files";
import { applyExactEdit, editDiff } from "../src/exact-edit";

const scope = { platform: "web", selfId: "bot", channelId: "c1", type: "direct", userId: "u1" } as unknown as ChannelContext;
const DEVICE = "d1";

type Invocation = { method: string; input: { path: string; data?: string; expectedSha256?: string | null } };

/** A device with files, the given features and project directories; it applies `expectedSha256` like a real client. */
function fakeDevice(initial: Record<string, string>, view: { features?: string[]; projectRoots?: string[] } = {}) {
  const files = new Map(Object.entries(initial));
  const calls: Invocation[] = [];
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const devices = {
    async list() {
      return [{ deviceId: DEVICE, capabilities: ["workspace.files"], ...view }];
    },
    async invoke(_deviceId: string, invocation: Invocation) {
      calls.push(invocation);
      const { path } = invocation.input;
      if (invocation.method === "read") {
        const text = files.get(path);
        return text === undefined
          ? { status: "failed", code: "file_not_found" }
          : { status: "succeeded", output: { data: Buffer.from(text).toString("base64") } };
      }
      if (invocation.method === "write") {
        const expected = invocation.input.expectedSha256;
        const current = files.get(path);
        if (expected === null && current !== undefined) return { status: "rejected", code: "file_exists" };
        if (typeof expected === "string" && (current === undefined || hash(current) !== expected)) return { status: "rejected", code: "file_changed" };
        files.set(path, Buffer.from(invocation.input.data!, "base64").toString("utf8"));
        return { status: "succeeded", output: {} };
      }
      if (invocation.method === "list") return { status: "rejected", code: path.includes("..") ? "invalid_file_input" : "path_outside_roots" };
      return { status: "succeeded", output: {} };
    },
  } as unknown as Devices;
  const state = new DeviceFileState(devices);
  const tools = [...createDeviceFileTools(devices, scope, () => DEVICE, state), createDeviceEditTool(devices, scope, () => DEVICE, state)];
  const tool = (name: string) => tools.find((candidate) => candidate.name === name) as AgentTool;
  const writes = () => calls.filter((call) => call.method === "write");
  return { files, calls, writes, tool, state };
}

let call = 0;
function execution(): AgentToolExecuteContext {
  return { runtime: { id: "r" }, turnId: "t", toolCallId: `c${++call}`, messages: [] } as unknown as AgentToolExecuteContext;
}

describe("device readFile", () => {
  it("returns numbered lines and pages through a long file", async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const device = fakeDevice({ "big.txt": lines });
    const first = await device.tool("readFile").execute!({ path: "big.txt", limit: 10 }, execution());
    expect(first).toMatchObject({ status: "succeeded", totalLines: 30, from: 1, to: 10, next: 11, uri: "workspace:///big.txt" });
    expect((first as { text: string }).text.split("\n")[0]).toBe("     1\tline 1");
    const tail = await device.tool("readFile").execute!({ path: "big.txt", offset: 28 }, execution());
    expect(tail).toMatchObject({ from: 28, to: 30, text: "    28\tline 28\n    29\tline 29\n    30\tline 30" });
    expect(tail).not.toHaveProperty("next");
  });

  it("shows CRLF lines without their carriage return and says so", async () => {
    const device = fakeDevice({ "win.txt": "a\r\nb\r\n" });
    await expect(device.tool("readFile").execute!({ path: "win.txt" }, execution())).resolves.toMatchObject({
      text: "     1\ta\n     2\tb",
      lineEndings: "crlf",
    });
  });
});

describe("device editFile", () => {
  it("edits only a file it has read, inserting newString literally, and shows the change", async () => {
    const device = fakeDevice({ "a.sh": "IFS=OLD\necho done\n", "compose.yaml": "a: X\nb: X\n" });
    await expect(device.tool("editFile").execute!({ path: "a.sh", oldString: "IFS=OLD", newString: "IFS=$'\\n'" }, execution())).resolves.toMatchObject({
      status: "rejected",
      code: "read_before_edit",
    });
    expect(device.writes()).toEqual([]);

    await device.tool("readFile").execute!({ path: "a.sh" }, execution());
    await expect(device.tool("editFile").execute!({ path: "a.sh", oldString: "IFS=OLD", newString: "IFS=$'\\n'" }, execution())).resolves.toMatchObject({
      status: "succeeded",
      replacements: 1,
      diff: "--- a/a.sh\n+++ b/a.sh\n@@ -1,2 +1,2 @@\n-IFS=OLD\n+IFS=$'\\n'\n echo done",
    });
    expect(device.files.get("a.sh")).toBe("IFS=$'\\n'\necho done\n");
    // Its own edit counts as seen: a second edit needs no new read.
    await expect(device.tool("editFile").execute!({ path: "a.sh", oldString: "echo done", newString: "echo ok" }, execution())).resolves.toMatchObject({
      status: "succeeded",
    });

    await device.tool("readFile").execute!({ path: "compose.yaml" }, execution());
    await expect(
      device.tool("editFile").execute!({ path: "compose.yaml", oldString: "X", newString: "$$HOME $&", replaceAll: true }, execution()),
    ).resolves.toMatchObject({
      status: "succeeded",
      replacements: 2,
    });
    expect(device.files.get("compose.yaml")).toBe("a: $$HOME $&\nb: $$HOME $&\n");
  });

  it("refuses to edit a file that changed after it was read", async () => {
    const device = fakeDevice({ "app.ts": "const a = 1;\n" });
    await device.tool("readFile").execute!({ path: "app.ts" }, execution());
    device.files.set("app.ts", "const a = 1;\nconst b = 2;\n");
    await expect(device.tool("editFile").execute!({ path: "app.ts", oldString: "a = 1", newString: "a = 3" }, execution())).resolves.toMatchObject({
      status: "rejected",
      code: "file_changed_since_read",
    });
    expect(device.writes()).toEqual([]);
    await device.tool("readFile").execute!({ path: "app.ts" }, execution());
    await expect(device.tool("editFile").execute!({ path: "app.ts", oldString: "a = 1", newString: "a = 3" }, execution())).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("asks the client to replace the file only if unchanged, when the client can check", async () => {
    const device = fakeDevice({ "app.ts": "x = 1\n" }, { features: ["project-files"] });
    await device.tool("readFile").execute!({ path: "app.ts" }, execution());
    await device.tool("editFile").execute!({ path: "app.ts", oldString: "x = 1", newString: "x = 2" }, execution());
    expect(device.writes()[0]!.input.expectedSha256).toBe(createHash("sha256").update("x = 1\n").digest("hex"));
    // Without the feature, nothing extra is sent: older clients refuse unknown fields.
    const old = fakeDevice({ "app.ts": "x = 1\n" });
    await old.tool("readFile").execute!({ path: "app.ts" }, execution());
    await old.tool("editFile").execute!({ path: "app.ts", oldString: "x = 1", newString: "x = 2" }, execution());
    expect(old.writes()[0]!.input).not.toHaveProperty("expectedSha256");
  });

  it("refuses an empty, unchanged, missing or ambiguous edit without writing, and spots line-number prefixes", async () => {
    const device = fakeDevice({ "f.txt": "a a\n" });
    await device.tool("readFile").execute!({ path: "f.txt" }, execution());
    for (const [input, code] of [
      [{ oldString: "", newString: "x" }, "empty_old_string"],
      [{ oldString: "a", newString: "a" }, "no_change"],
      [{ oldString: "b", newString: "c" }, "not_found"],
      [{ oldString: "a", newString: "c" }, "ambiguous"],
    ] as const)
      await expect(device.tool("editFile").execute!({ path: "f.txt", ...input }, execution())).resolves.toMatchObject({ status: "rejected", code });
    await expect(device.tool("editFile").execute!({ path: "f.txt", oldString: "     1\ta a", newString: "b" }, execution())).resolves.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("行号前缀"),
    });
    expect(device.writes()).toEqual([]);
  });
});

describe("device writeFile", () => {
  it("creates a new file, but overwrites an existing one only after reading it", async () => {
    const device = fakeDevice({ "keep.txt": "keep\n" }, { features: ["project-files"] });
    await expect(device.tool("writeFile").execute!({ path: "new.txt", content: "a\nb\n" }, execution())).resolves.toMatchObject({
      status: "succeeded",
      lines: 2,
    });
    await expect(device.tool("writeFile").execute!({ path: "keep.txt", content: "lost\n" }, execution())).resolves.toMatchObject({
      status: "rejected",
      code: "file_exists",
      message: expect.stringContaining("先用 readFile"),
    });
    expect(device.files.get("keep.txt")).toBe("keep\n");
    await device.tool("readFile").execute!({ path: "keep.txt" }, execution());
    await expect(device.tool("writeFile").execute!({ path: "keep.txt", content: "replaced\n" }, execution())).resolves.toMatchObject({ status: "succeeded" });
    expect(device.files.get("keep.txt")).toBe("replaced\n");
  });
});

// Preview records, 2026-11-19: `listFiles {path: "."}` was refused in three tasks without saying why.
describe("device paths", () => {
  it("sends '.', a leading './' and stray slashes as the paths the client accepts, and explains a refused path", async () => {
    const device = fakeDevice({ "a.txt": "x\n" });
    await device.tool("listFiles").execute!({ path: "." }, execution());
    await device.tool("readFile").execute!({ path: "./a.txt" }, execution());
    await device.tool("listFiles").execute!({ path: "docs//sub/" }, execution());
    expect(device.calls.map((call) => call.input.path)).toEqual(["", "a.txt", "docs/sub"]);
    await expect(device.tool("listFiles").execute!({ path: "../outside" }, execution())).resolves.toMatchObject({
      code: "invalid_file_input",
      message: expect.stringContaining("相对路径"),
    });
  });
});

describe("project directories", () => {
  it("refuses absolute paths before reaching a client without project support or without directories", async () => {
    const old = fakeDevice({});
    await expect(old.tool("readFile").execute!({ path: "/srv/app/a.ts" }, execution())).resolves.toMatchObject({ code: "client_update_required" });
    const none = fakeDevice({}, { features: ["project-files"] });
    await expect(none.tool("editFile").execute!({ path: "C:\\code\\a.ts", oldString: "a", newString: "b" }, execution())).resolves.toMatchObject({
      code: "path_outside_roots",
    });
    expect([...old.calls, ...none.calls]).toEqual([]);
  });

  it("names the open directories when a path is outside them, and in the prompt", async () => {
    const device = fakeDevice({}, { features: ["project-files"], projectRoots: ["/home/me/code/app"] });
    await expect(device.tool("listFiles").execute!({ path: "/etc" }, execution())).resolves.toMatchObject({
      code: "path_outside_roots",
      message: expect.stringContaining("/home/me/code/app"),
    });
    expect(await projectFilesPrompt(device.state, DEVICE)).toContain("/home/me/code/app");
    expect(await projectFilesPrompt(fakeDevice({}).state, DEVICE)).toBe("");
  });

  it("tracks reads per normalized path", async () => {
    const device = fakeDevice({ "/srv/app/a.ts": "x\n" }, { features: ["project-files"], projectRoots: ["/srv/app"] });
    await device.tool("readFile").execute!({ path: "/srv/app/a.ts" }, execution());
    expect(device.state.seenHash(DEVICE, "/srv//app/a.ts")).toBeDefined();
    expect(device.state.seenHash(DEVICE, "/srv/app/b.ts")).toBeUndefined();
  });
});

describe("applyExactEdit", () => {
  it("never expands replacement patterns", () => {
    for (const pattern of ["$$", "$&", "$`", "$'", "$1", "$<name>"]) {
      expect(applyExactEdit("x-OLD-y", "OLD", pattern)).toMatchObject({ ok: true, text: `x-${pattern}-y`, replacements: 1 });
      expect(applyExactEdit("OLD OLD", "OLD", pattern, true)).toMatchObject({ ok: true, text: `${pattern} ${pattern}`, replacements: 2 });
    }
  });

  it("matches an LF oldString in a CRLF file and keeps CRLF", () => {
    expect(applyExactEdit("a\r\nb\r\nc\r\n", "a\nb", "x\ny")).toMatchObject({ ok: true, text: "x\r\ny\r\nc\r\n" });
  });
});

describe("editDiff", () => {
  const diff = (before: string, oldString: string, newString: string, replaceAll = false) => {
    const edit = applyExactEdit(before, oldString, newString, replaceAll);
    if (!edit.ok) throw new Error(edit.code);
    return editDiff("f", before, edit.text, edit.spans);
  };
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `l${index + 1}`).join("\n") + "\n";

  it("shows a change with three lines of context and correct line numbers", () => {
    expect(diff(lines(10), "l5\n", "five\nFIVE\n")).toBe(
      ["--- a/f", "+++ b/f", "@@ -2,7 +2,8 @@", " l2", " l3", " l4", "-l5", "+five", "+FIVE", " l6", " l7", " l8"].join("\n"),
    );
  });

  it("shows a deleted line and a change inside one line", () => {
    expect(diff(lines(3), "l2\n", "")).toBe(["--- a/f", "+++ b/f", "@@ -1,3 +1,2 @@", " l1", "-l2", " l3"].join("\n"));
    expect(diff("foo bar baz\n", "bar ", "")).toBe(["--- a/f", "+++ b/f", "@@ -1,1 +1,1 @@", "-foo bar baz", "+foo baz"].join("\n"));
  });

  it("gives far-apart changes their own hunks, shifting later line numbers", () => {
    const text = lines(20).replace("l2\n", "X\n").replace("l18\n", "X\n");
    expect(diff(text, "X\n", "Y\nY\n", true)).toBe(
      [
        "--- a/f",
        "+++ b/f",
        "@@ -1,5 +1,6 @@",
        " l1",
        "-X",
        "+Y",
        "+Y",
        " l3",
        " l4",
        " l5",
        "@@ -15,6 +16,7 @@",
        " l15",
        " l16",
        " l17",
        "-X",
        "+Y",
        "+Y",
        " l19",
        " l20",
      ].join("\n"),
    );
  });

  it("joins two changes on one line into one block", () => {
    expect(diff("a b a\nz\n", "a", "c", true)).toBe(["--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", "-a b a", "+c b c", " z"].join("\n"));
  });
});
