import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { formatBashInstructions, formatWorkspacePrompt } from "../src/prompt";
import { Workspace } from "../src/workspace";

describe("shared workspace configuration", () => {
  it("describes shared visibility instead of channel isolation", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-shared-workspace-"));
    const workspace = await Workspace.create({ root, filesystem: {}, bash: {} });

    const isolated = formatWorkspacePrompt(workspace);
    const shared = formatWorkspacePrompt(workspace, { shared: true });

    expect(isolated).toContain("工作区按频道隔离");
    expect(shared).toContain("工作区由已启用频道共享");
    expect(shared).toContain("文件内容不只对当前对话可见");
    expect(shared).not.toContain("工作区按频道隔离");
    // Command details moved to the bash tool description.
    expect(shared).not.toContain("Git");
    expect(formatBashInstructions(workspace)).toContain("Git data persists in the workspace");
  });
});
