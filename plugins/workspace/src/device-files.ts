import type { AgentTool, AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import type { DeviceView, OperationResult } from "@yesimbot/contracts";
import { AppError, contentHash, newId, systemClock, type Clock } from "@yesimbot/foundation";
import { toolActors, type ChannelContext, type Devices } from "koishi-plugin-yesimbot/kernel";
import { z } from "zod/v4";

import { toolOperationId } from "./computer-call.js";
import { applyExactEdit, EDIT_FILE_SCHEMA, editDiff, hasLineNumberPrefix, type ExactEditRefusal } from "./exact-edit.js";

/** Lines one `readFile` returns by default, and the characters it returns at most. */
const READ_LINES = 2000;
const READ_CHARS = 20_000;
const LINE_CHARS = 2000;
/** How long a looked-up device (features, project directories) is reused. */
const DEVICE_CACHE_MS = 30_000;

const PATH_ONLY = z.strictObject({ path: z.string().max(4096) });

const READ_FILE_SCHEMA = z.strictObject({
  path: z.string().max(4096),
  offset: z.int().min(1).describe("从第几行开始读（从 1 开始）").optional(),
  limit: z.int().min(1).max(READ_LINES).describe("最多读几行").optional(),
});

const WRITE_FILE_SCHEMA = z.strictObject({ path: z.string().max(4096), content: z.string().max(128 * 1024) });

const PATH_DESCRIPTION = "path：会话目录里的相对路径，或电脑主人在客户端设置里开放的项目目录下的绝对路径（其他位置不能用文件工具访问，只能用命令行）。";

/**
 * What the bot last saw of each device file in one runtime. Editing or overwriting a file needs a read first, and is
 * refused when the file changed since (a person, a formatter, a command): the bot works from what it has seen. Also
 * caches what each computer supports, so a call does not look the device up every time.
 */
export class DeviceFileState {
  private readonly seen = new Map<string, string>();
  private readonly views = new Map<string, { at: number; view?: DeviceView }>();

  constructor(
    private readonly devices: Pick<Devices, "list">,
    public readonly clock: Clock = systemClock(),
  ) {}

  remember(deviceId: string, path: string, content: Uint8Array): void {
    this.seen.set(key(deviceId, path), sha256(content));
  }

  /** Hash of the content last read or written, if the bot has seen this file. */
  seenHash(deviceId: string, path: string): string | undefined {
    return this.seen.get(key(deviceId, path));
  }

  async view(deviceId: string): Promise<DeviceView | undefined> {
    const cached = this.views.get(deviceId);
    if (cached && this.clock.now() - cached.at < DEVICE_CACHE_MS) return cached.view;
    let view: DeviceView | undefined;
    try {
      view = (await this.devices.list()).find((item) => item.deviceId === deviceId && !item.revokedAt);
    } catch {
      // Unknown support: only what every client accepts is sent.
    }
    this.views.set(deviceId, { at: this.clock.now(), view });
    return view;
  }

  async projectFiles(deviceId: string): Promise<boolean> {
    return (await this.view(deviceId))?.features?.includes("project-files") ?? false;
  }
}

/**
 * Device file tools: relative paths stay in the conversation's own directory, absolute ones only in the project
 * directories the computer's owner opened. `device` is read at call time: the bot may switch computers.
 */
export function createDeviceFileTools(
  devices: Devices,
  scope: ChannelContext,
  device: () => string,
  state: DeviceFileState = new DeviceFileState(devices),
): AgentTool[] {
  const call = (execution: AgentToolExecuteContext, deviceId: string, method: string, input: Record<string, unknown>, segment = method) =>
    devices.invoke(
      deviceId,
      {
        scope,
        actors: toolActors(execution.messages, scope.platform),
        operationId: toolOperationId(execution, `files/${segment}`),
        capability: "workspace.files",
        method,
        input,
        expiresAt: state.clock.now() + 30_000,
      },
      execution.abortSignal,
    );
  const readFile: AgentTool<{ path: string; offset?: number; limit?: number }> = {
    name: "readFile",
    description:
      `readFile：读取电脑上的文件。${PATH_DESCRIPTION}` +
      "文字文件按行返回，每行前面是行号和制表符（只用于显示，不属于文件内容）；默认从第 1 行读，一次最多约 2000 行或 2 万字，没读完时返回 next，用 offset（起始行号）和 limit（行数）继续读。修改或覆盖已有文件前必须先读。",
    inputSchema: READ_FILE_SCHEMA,
    execute: async (input, execution) => {
      const deviceId = device();
      const refused = await refusePath(state, deviceId, input.path);
      if (refused) return refused;
      const result = await call(execution, deviceId, "read", { path: input.path });
      if (result.status !== "succeeded") return explain(result, state, deviceId);
      const bytes = decodeFile(result.output);
      const uri = isAbsolutePath(input.path) ? {} : { uri: `workspace:///${input.path}` };
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return {
          status: "succeeded",
          bytes: bytes.length,
          ...uri,
          message: isAbsolutePath(input.path) ? "二进制文件，不能按文字读取。" : "二进制文件，使用 read 读取该 URI。",
        };
      }
      state.remember(deviceId, input.path, bytes);
      return { status: "succeeded", ...uri, ...numberedLines(text, input.offset, input.limit) };
    },
  };
  const writeFile: AgentTool<{ path: string; content: string }> = {
    name: "writeFile",
    description:
      `writeFile：新建文件，或把整个文件换成 content（UTF-8 文字）。${PATH_DESCRIPTION}` +
      "覆盖已有文件前必须先 readFile 读过；读完后文件又被改动会被拒绝，需要重新读取。局部修改用 editFile。缺少的上级目录会自动创建。",
    inputSchema: WRITE_FILE_SCHEMA,
    execute: async (input, execution) => {
      const deviceId = device();
      const refused = await refusePath(state, deviceId, input.path);
      if (refused) return refused;
      const bytes = Buffer.from(input.content ?? "", "utf8");
      // The client replaces the file only if it is still what the bot read (or, unread, does not exist yet).
      const check = (await state.projectFiles(deviceId)) ? { expectedSha256: state.seenHash(deviceId, input.path) ?? null } : {};
      const result = await call(execution, deviceId, "write", { path: input.path, data: bytes.toString("base64"), ...check });
      if (result.status !== "succeeded") return explain(result, state, deviceId);
      state.remember(deviceId, input.path, bytes);
      return {
        status: "succeeded",
        ...(isAbsolutePath(input.path) ? {} : { uri: `workspace:///${input.path}` }),
        bytes: bytes.length,
        lines: lineCount(input.content ?? ""),
      };
    },
  };
  const listFiles: AgentTool<{ path: string }> = {
    name: "listFiles",
    description: `listFiles：列出目录里的文件和子目录。path 留空是会话目录；也可以是会话目录里的相对路径，或项目目录下的绝对路径。`,
    inputSchema: PATH_ONLY,
    execute: async (input, execution) => {
      const deviceId = device();
      const refused = await refusePath(state, deviceId, input.path);
      if (refused) return refused;
      const result = await call(execution, deviceId, "list", { path: input.path });
      return result.status === "succeeded" ? result : explain(result, state, deviceId);
    },
  };
  return ([readFile, writeFile, listFiles] as AgentTool[]).map(withDevicePath);
}

/**
 * editFile for device storage: an exact text replacement of a file the bot has read and that has not changed since.
 * The client replaces it only if it still has the content just edited, and the result shows the change as a diff.
 */
export function createDeviceEditTool(
  devices: Devices,
  scope: ChannelContext,
  device: () => string,
  state: DeviceFileState = new DeviceFileState(devices),
): AgentTool {
  return withDevicePath({
    name: "editFile",
    description:
      `editFile：精确替换电脑上一个文字文件里的一段内容，用于局部修改，不必整篇重写。${PATH_DESCRIPTION}` +
      "改之前必须先用 readFile 读过这个文件；读完后文件又被改动（包括命令行或别人修改）会被拒绝，需要重新读取。" +
      "oldString 必须和文件内容逐字一致（包括空白和缩进），不要带 readFile 显示的行号前缀；出现多次时用更长的片段或 replaceAll。成功后返回改动的 diff。新建文件或整篇重写用 writeFile。",
    inputSchema: EDIT_FILE_SCHEMA,
    execute: async (input, execution) => {
      // Refuse before touching the device; the schema is not necessarily validated at runtime.
      if (!input.oldString || input.oldString === input.newString)
        return {
          status: "rejected",
          code: input.oldString ? "no_change" : "empty_old_string",
          message: deviceRefusalMessage(input.oldString ? "no_change" : "empty_old_string"),
        };
      const deviceId = device();
      const refused = await refusePath(state, deviceId, input.path);
      if (refused) return refused;
      const actors = toolActors(execution.messages, scope.platform);
      const call = (method: "read" | "write", body: Record<string, unknown>) =>
        devices.invoke(
          deviceId,
          {
            scope,
            actors,
            operationId: toolOperationId(execution, `files/edit-${method}`),
            capability: "workspace.files",
            method,
            input: body,
            expiresAt: state.clock.now() + 30_000,
          },
          execution.abortSignal,
        );
      const read = await call("read", { path: input.path });
      if (read.status !== "succeeded") return explain(read, state, deviceId);
      const bytes = decodeFile(read.output);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return { status: "rejected", code: "not_text", message: "不是 UTF-8 文字文件，不能用 editFile 修改。" };
      }
      const seen = state.seenHash(deviceId, input.path);
      if (!seen) return { status: "rejected", code: "read_before_edit", message: "改之前先用 readFile 读这个文件，看过当前内容再改。" };
      const current = sha256(bytes);
      if (seen !== current)
        return {
          status: "rejected",
          code: "file_changed_since_read",
          message: "这个文件在你上次读取之后被改过（可能是用户、其他程序或命令行），先重新 readFile 看最新内容，再决定怎么改。",
        };
      const edit = applyExactEdit(text, input.oldString, input.newString, input.replaceAll);
      if (!edit.ok)
        return {
          status: "rejected",
          code: edit.code,
          message:
            deviceRefusalMessage(edit.code, edit.occurrences) +
            (edit.code === "not_found" && hasLineNumberPrefix(input.oldString) ? "oldString 里像是带了行号前缀，去掉它再试。" : ""),
        };
      const updated = Buffer.from(edit.text, "utf8");
      const check = (await state.projectFiles(deviceId)) ? { expectedSha256: current } : {};
      const written = await call("write", { path: input.path, data: updated.toString("base64"), ...check });
      if (written.status !== "succeeded") return explain(written, state, deviceId);
      state.remember(deviceId, input.path, updated);
      return {
        status: "succeeded",
        replacements: edit.replacements,
        ...(isAbsolutePath(input.path) ? {} : { uri: `workspace:///${input.path}` }),
        diff: editDiff(input.path, text, edit.text, edit.spans),
      };
    },
  } as AgentTool);
}

/** The project directories of the computer in use, for the system prompt; empty when it has none. */
export async function projectFilesPrompt(state: DeviceFileState, deviceId: string | undefined): Promise<string> {
  if (!deviceId) return "";
  const view = await state.view(deviceId);
  if (!view?.features?.includes("project-files") || !view.projectRoots?.length) return "";
  return `这台电脑的主人开放了这些项目目录，文件工具可以用绝对路径直接读写其中的文件：${view.projectRoots.join("、")}。改代码和配置优先用 readFile/editFile（会检查读后是否被改动并返回 diff），不要用命令行拼 sed 或 heredoc 改文件。`;
}

export async function readDeviceFile(
  devices: Devices,
  scope: ChannelContext,
  deviceId: string,
  path: string,
  options: { actorIds?: readonly string[]; maxBytes: number; signal: AbortSignal; clock?: Clock },
): Promise<Uint8Array> {
  const result = await devices.invoke(
    deviceId,
    {
      scope,
      actors: (options.actorIds ?? []).map((userId) => ({ platform: scope.platform, userId })),
      operationId: newId(),
      capability: "workspace.files",
      method: "read",
      input: { path },
      expiresAt: (options.clock ?? systemClock()).now() + 30_000,
    },
    options.signal,
  );
  if (result.status !== "succeeded") throw new AppError("workspace_device_file_unavailable", { effect: "none" });
  const bytes = decodeFile(result.output);
  if (bytes.length > options.maxBytes) throw new AppError("workspace_device_file_too_large", { effect: "none" });
  return bytes;
}

/** POSIX, drive-letter and UNC paths; everything else is relative to the conversation's directory. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** An absolute path is refused before reaching a client that cannot take one, or a computer with no project directory. */
async function refusePath(state: DeviceFileState, deviceId: string, path: string): Promise<(OperationResult & { message: string }) | undefined> {
  if (typeof path !== "string" || !isAbsolutePath(path)) return undefined;
  const view = await state.view(deviceId);
  if (!view?.features?.includes("project-files"))
    return {
      status: "rejected",
      code: "client_update_required",
      message: "这台电脑的客户端还不支持项目目录，文件工具只能用会话目录里的相对路径；更新电脑客户端后才能用绝对路径。",
    };
  if (!view.projectRoots?.length)
    return {
      status: "rejected",
      code: "path_outside_roots",
      message: "这台电脑没有开放项目目录，文件工具只能用会话目录里的相对路径。项目目录由电脑主人在客户端设置里添加，bot 不能自己添加。",
    };
  return undefined;
}

/** Says what a refused or failed file call means; the client's own code stays. */
async function explain(result: OperationResult, state: DeviceFileState, deviceId: string): Promise<unknown> {
  if (result.status === "succeeded" || result.status === "unknown") return result;
  const message = await fileMessage(result.code, state, deviceId);
  return message ? { ...result, message } : result;
}

async function fileMessage(code: string, state: DeviceFileState, deviceId: string): Promise<string | undefined> {
  switch (code) {
    case "path_outside_roots": {
      const roots = (await state.view(deviceId))?.projectRoots ?? [];
      return `这个路径不在电脑开放的项目目录里${roots.length ? `（开放的目录：${roots.join("、")}）` : ""}。项目目录由电脑主人在客户端设置里添加，bot 不能自己添加；其他位置只能用命令行或会话目录。`;
    }
    case "project_root_unavailable":
      return "这个项目目录在电脑上不存在或无法访问，请让电脑主人检查客户端设置。";
    case "file_exists":
      return "文件已经存在：先用 readFile 读它，再用 editFile 修改或用 writeFile 覆盖。";
    case "file_changed":
      return "文件在你上次读取之后被改过，没有写入。先重新 readFile 看最新内容，再决定怎么改。";
    case "file_hardlinked":
      return "这个文件有多个硬链接，整篇替换会把它和其他链接分开，没有写入。需要时用命令行处理。";
    case "not_a_file":
      return "这个路径是目录或特殊文件，不能当文件写入。";
    case "invalid_file_input":
      return "path 不合法，没有执行。会话目录里的文件用相对路径：不以 / 开头，不含 ..、反斜杠、冒号或 Windows 保留名，空字符串表示会话目录本身；项目目录里的文件用完整的绝对路径。";
    case "file_not_found":
      return "文件或目录不存在，检查路径（可以先 listFiles 看看）。";
    case "parent_not_found":
      return "上级目录不存在。";
    case "file_unavailable":
      return "不是普通文件，或文件超过 8 MB。";
    default:
      return undefined;
  }
}

/**
 * `.`, a leading `./`, doubled and trailing slashes mean what they say, but the client refuses them (preview records,
 * 2026-11-19: `listFiles {path: "."}` failed in three tasks). Absolute paths are left to the client's checks.
 */
function withDevicePath(tool: AgentTool): AgentTool {
  return { ...tool, execute: (input, execution) => tool.execute({ ...input, path: devicePath(input?.path) }, execution) };
}

function devicePath(path: unknown): unknown {
  if (typeof path !== "string" || isAbsolutePath(path)) return path;
  let normalized = path.replace(/\/{2,}/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+$/, "");
  return normalized === "." ? "" : normalized;
}

function numberedLines(text: string, offset = 1, limit = READ_LINES) {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  const total = text ? lines.length : 0;
  const from = Math.min(Math.max(1, Math.floor(offset)), Math.max(1, total));
  const rows: string[] = [];
  let chars = 0,
    to = from - 1;
  for (let index = from - 1; index < total && rows.length < Math.max(1, Math.floor(limit)); index++) {
    let line = lines[index]!.endsWith("\r") ? lines[index]!.slice(0, -1) : lines[index]!;
    if (line.length > LINE_CHARS) line = `${line.slice(0, LINE_CHARS)}…（此行过长，已截断）`;
    const row = `${String(index + 1).padStart(6)}\t${line}`;
    if (rows.length && chars + row.length + 1 > READ_CHARS) break;
    rows.push(row);
    chars += row.length + 1;
    to = index + 1;
  }
  return {
    totalLines: total,
    from,
    to,
    ...(to < total ? { next: to + 1 } : {}),
    ...(text.includes("\r\n") ? { lineEndings: "crlf" } : {}),
    text: rows.join("\n"),
  };
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function deviceRefusalMessage(code: ExactEditRefusal, occurrences = 0): string {
  switch (code) {
    case "empty_old_string":
      return "oldString 不能为空；新建文件或整篇重写用 writeFile。";
    case "no_change":
      return "oldString 和 newString 相同，不需要修改。";
    case "not_found":
      return "文件里没有找到 oldString，确认它和文件内容逐字一致（包括空白和缩进）。";
    case "ambiguous":
      return `oldString 在文件里出现 ${occurrences} 次；换更长、唯一的片段，或设 replaceAll: true。`;
  }
}

function key(deviceId: string, path: string): string {
  const normalized = isAbsolutePath(path)
    ? path
        .replace(/\\/g, "/")
        .replace(/\/{2,}/g, "/")
        .replace(/(.)\/$/, "$1")
        .replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`)
    : path.replace(/^(\.\/)+/, "").replace(/\/{2,}/g, "/");
  return `${deviceId}\0${normalized}`;
}

function sha256(bytes: Uint8Array): string {
  return contentHash(bytes);
}

function decodeFile(output: unknown): Buffer {
  const data = (output as { data?: unknown } | undefined)?.data;
  if (typeof data !== "string" || data.length > 12 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
    throw new AppError("workspace_device_file_invalid", { effect: "none" });
  return Buffer.from(data, "base64");
}
