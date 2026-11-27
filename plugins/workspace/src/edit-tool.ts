import type { AgentTool } from "@yesimbot/agent-runtime";

import type { WorkspaceBashBackend } from "./bash-tool";
import { applyExactEdit, EDIT_FILE_SCHEMA, editDiff, hasLineNumberPrefix, type ExactEditRefusal } from "./exact-edit";

export interface CreateEditToolInput {
  backend: WorkspaceBashBackend;
  cwd: string;
}

export function createEditTool(input: CreateEditToolInput): AgentTool {
  const { backend, cwd } = input;

  return {
    name: "editFile",
    description:
      "Make a targeted edit to a file by specifying the exact text to find and its replacement. " +
      "Use this for surgical changes instead of rewriting the entire file with writeFile; the result shows the change as a diff. " +
      "The oldString must match the file content exactly (including indentation and whitespace). " +
      "For creating new files or full rewrites, use writeFile instead.",
    inputSchema: EDIT_FILE_SCHEMA,
    async execute({ path, oldString, newString, replaceAll }) {
      const resolvedPath = resolvePath(cwd, path);

      let content: string;
      try {
        content = await backend.readFile(resolvedPath);
      } catch {
        return { success: false, error: `File not found: ${resolvedPath}` };
      }

      const edit = applyExactEdit(content, oldString, newString, replaceAll);
      if (!edit.ok)
        return {
          success: false,
          error:
            refusalMessage(edit.code, edit.occurrences) +
            (edit.code === "not_found" && hasLineNumberPrefix(oldString) ? " It looks like oldString includes line-number prefixes; remove them." : ""),
        };

      await backend.writeFiles([{ path: resolvedPath, content: edit.text }]);

      return { success: true, replacements: edit.replacements, diff: editDiff(path, content, edit.text, edit.spans) };
    },
  };
}

function refusalMessage(code: ExactEditRefusal, occurrences = 0): string {
  switch (code) {
    case "empty_old_string":
      return "oldString must not be empty. Use writeFile to create a file or rewrite it entirely.";
    case "no_change":
      return "oldString and newString are identical; no change needed";
    case "not_found":
      return "oldString not found in the file. Ensure it matches exactly, including whitespace and indentation.";
    case "ambiguous":
      return `oldString appears ${occurrences} times in the file. Set replaceAll: true to replace all, or provide a more specific oldString that matches uniquely.`;
  }
}

function resolvePath(cwd: string, path: string): string {
  if (path.startsWith("/")) return path;
  // Simple posix join for sandbox paths
  const base = cwd.endsWith("/") ? cwd : cwd + "/";
  return base + path;
}
