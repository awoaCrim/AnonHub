import { operationResultSchema } from "@yesimbot/contracts";
import { isComputerTool } from "@yesimbot/contracts/tools";

/**
 * Only the known device operation envelope marks computer execution as uncertain. A shell command an older client
 * stopped at its timeout (`shell_interrupted`) ran and was ended there: the task may inspect and go on (user,
 * 2026-11-19: separate a timeout from an unknown result). Newer clients report that case as a result with `timedOut`.
 */
export function computerOperationUnknown(name: string, output: unknown): boolean {
  if (!isComputerTool(name) || !output || typeof output !== "object" || Array.isArray(output)) return false;
  const result = output as Record<string, unknown>;
  if (result.status !== "unknown") return false;
  if (name === "computer_exec" && result.code === "shell_interrupted") return false;
  // Workspace may append display/coordinate metadata to the device envelope.
  const parsed = operationResultSchema.safeParse({ status: result.status, code: result.code });
  return parsed.success && parsed.data.status === "unknown";
}
