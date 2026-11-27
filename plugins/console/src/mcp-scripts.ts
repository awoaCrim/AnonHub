import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { contentHash, writeFileAtomic } from "@yesimbot/foundation";

/**
 * MCP scripts the bot wrote on its computer, copied into this instance so a stdio server can run them
 * (user, 2026-11-19: the bot sets MCP up by itself; scripts run in the main program). stdio commands run where
 * Koishi runs, which cannot see the computer's files; this directory is the bridge.
 */
export const MCP_SCRIPT_DIR = "mcp";

export const MCP_SCRIPT_MAX_BYTES = 512 * 1024;

export const MCP_SCRIPT_ERRORS = [
  "invalid_mcp_script_name",
  "mcp_script_empty",
  "mcp_script_too_large",
  "mcp_script_not_text",
  "mcp_script_target_invalid",
  "mcp_computer_unavailable",
  "mcp_script_read_failed",
] as const;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Node only: the image has no other runtime every instance can count on, and nothing installs dependencies. */
const EXTENSIONS = [".mjs", ".cjs", ".js"];

/** The script's file name on the server: the given name, or the computer file's own. */
export function mcpScriptName(path: string, name?: string): string {
  const chosen = name ?? path.replaceAll("\\", "/").split("/").at(-1) ?? "";
  if (!NAME.test(chosen) || chosen.includes("..") || !EXTENSIONS.some((extension) => chosen.endsWith(extension))) throw Error("invalid_mcp_script_name");
  return chosen;
}

/** Writes the script atomically (private to the Koishi user) and returns the stdio entry that runs it. */
export async function installMcpScript(baseDir: string, name: string, bytes: Uint8Array) {
  if (!bytes.length) throw Error("mcp_script_empty");
  if (bytes.length > MCP_SCRIPT_MAX_BYTES) throw Error("mcp_script_too_large");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw Error("mcp_script_not_text");
  }
  const directory = join(baseDir, MCP_SCRIPT_DIR);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, name);
  const existing = await lstat(target).catch(() => undefined);
  if (existing && !existing.isFile()) throw Error("mcp_script_target_invalid");
  await writeFileAtomic(target, bytes, { mode: 0o600 });
  return {
    path: target,
    bytes: bytes.length,
    sha256: contentHash(bytes),
    replaced: !!existing,
    stdio: { type: "stdio", command: "node", args: [target] },
  };
}

/** The device's file read answer, `{ data: base64 }`. */
export function deviceFileBytes(output: unknown): Buffer {
  const data = (output as { data?: unknown } | undefined)?.data;
  if (typeof data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw Error("mcp_script_read_failed");
  if (data.length > Math.ceil(MCP_SCRIPT_MAX_BYTES / 3) * 4) throw Error("mcp_script_too_large");
  return Buffer.from(data, "base64");
}
