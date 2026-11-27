import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { deviceFileBytes, installMcpScript, MCP_SCRIPT_MAX_BYTES, mcpScriptName } from "../src/mcp-scripts.js";

const made: string[] = [];
afterEach(async () => {
  for (const directory of made.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function base() {
  const directory = await mkdtemp(join(tmpdir(), "yesimbot-mcp-scripts-"));
  made.push(directory);
  return directory;
}

it("names a script after its computer file unless told otherwise, Node scripts only", () => {
  expect(mcpScriptName("tools/fxtwitter-mcp.mjs")).toBe("fxtwitter-mcp.mjs");
  expect(mcpScriptName("C:\\work\\server.cjs")).toBe("server.cjs");
  expect(mcpScriptName("x.mjs", "renamed.js")).toBe("renamed.js");
  for (const [path, name] of [
    ["tool.py"],
    ["x.mjs", "../up.mjs"],
    ["x.mjs", ".hidden.mjs"],
    ["x.mjs", "a..b.mjs"],
    ["dir/"],
    ["x.mjs", "x".repeat(70) + ".mjs"],
  ])
    expect(() => mcpScriptName(path, name)).toThrow("invalid_mcp_script_name");
});

it("writes the script privately and atomically, and refuses empty, binary, oversized or linked targets", async () => {
  const root = await base();
  const first = await installMcpScript(root, "server.mjs", Buffer.from("console.log(1)\n"));
  expect(first).toMatchObject({
    path: join(root, "mcp", "server.mjs"),
    bytes: 15,
    replaced: false,
    stdio: { command: "node", args: [join(root, "mcp", "server.mjs")] },
  });
  expect(await installMcpScript(root, "server.mjs", Buffer.from("console.log(2)\n"))).toMatchObject({ replaced: true });
  // No temporary file is left behind.
  expect(await readdir(join(root, "mcp"))).toEqual(["server.mjs"]);
  await expect(installMcpScript(root, "empty.mjs", Buffer.alloc(0))).rejects.toThrow("mcp_script_empty");
  await expect(installMcpScript(root, "binary.mjs", Buffer.from([0xff, 0xfe, 0x00]))).rejects.toThrow("mcp_script_not_text");
  await expect(installMcpScript(root, "big.mjs", Buffer.alloc(MCP_SCRIPT_MAX_BYTES + 1, 0x61))).rejects.toThrow("mcp_script_too_large");
  await writeFile(join(root, "elsewhere.mjs"), "outside");
  await symlink(join(root, "elsewhere.mjs"), join(root, "mcp", "linked.mjs"));
  await expect(installMcpScript(root, "linked.mjs", Buffer.from("x"))).rejects.toThrow("mcp_script_target_invalid");
});

it("accepts only a well-formed device file answer within the size limit", () => {
  expect(deviceFileBytes({ data: Buffer.from("hi").toString("base64") }).toString()).toBe("hi");
  expect(() => deviceFileBytes({ data: "not base64!" })).toThrow("mcp_script_read_failed");
  expect(() => deviceFileBytes(undefined)).toThrow("mcp_script_read_failed");
  expect(() => deviceFileBytes({ data: Buffer.alloc(MCP_SCRIPT_MAX_BYTES + 3).toString("base64") })).toThrow("mcp_script_too_large");
});
