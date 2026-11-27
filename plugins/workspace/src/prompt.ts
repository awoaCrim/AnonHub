import { DEFAULT_WORKSPACE_MOUNT } from "./mounts";
import { BASH_TIMEOUT_MS, type Workspace } from "./workspace";

export interface WorkspacePromptOptions {
  readonly shared?: boolean;
}

/** Always-present orientation; command details live in the bash tool description. */
export function formatWorkspacePrompt(workspace: Workspace, options: WorkspacePromptOptions = {}): string {
  const mountLines = workspace.mounts.map((mount) => `- ${mount.path}：${formatMountLabel(mount.kind)}`);
  return [
    "## 工作区沙箱",
    `bash、readFile、writeFile 等工作区工具运行在 just-bash 虚拟沙箱中，不是宿主机 shell；当前工作目录 ${DEFAULT_WORKSPACE_MOUNT}。${options.shared ? "工作区由已启用频道共享，文件内容不只对当前对话可见。" : "工作区按频道隔离，文件只在当前频道内共享。"}`,
    "文件系统挂载：",
    ...mountLines,
    "workspace:///x.png 与 /home/workspace/x.png 指向同一工作区文件：前者用于 Core read 和 img/file 引用，bash 不接受 workspace:// URI。技能用 Core read 读取 skill://<skill-name>/SKILL.md。",
  ].join("\n");
}

/** Appended to the bash tool description, so it is read when the tool is actually considered. */
export function formatBashInstructions(workspace: Workspace): string {
  const network = workspace.config.bash.network;
  return [
    `Network: ${network ? "enabled (private/local addresses are refused)" : "disabled"}; command timeout ${BASH_TIMEOUT_MS} ms; stdout/stderr are each capped at about 30 KB, so narrow large output first.`,
    "Commands may not exist: check with help or which first. Shell state is not kept between calls; put dependent steps in one command. File changes persist in the workspace.",
    `Git data persists in the workspace; local init/add/config/commit/status/log/diff/branch/checkout work. ${network ? "Remote Git supports public HTTPS clone/fetch/pull only (no SSH, auth or push)." : "Remote Git is unavailable because the network is disabled."}`,
    "asset:// inputs and artifact:// tool outputs are not mounted: read them with Core read, then write into the workspace if bash needs them. Refer to sandbox files externally as workspace://.",
    "Skill scripts run only from /skills/<skill-name>/...; skill files are read-only.",
  ].join(" ");
}

function formatMountLabel(kind: Workspace["mounts"][number]["kind"]): string {
  if (kind === "read-only") {
    return "只读（写入会失败）";
  }
  if (kind === "overlay") {
    return "覆盖层（能读到真实内容，但写入只停留在内存，看起来成功却不会落盘，下次调用即消失）";
  }
  return "持久（真实读写，改动会落盘）";
}
