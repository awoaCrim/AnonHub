import { modelFailureInfo, modelFailureMessage, type AgentDiagnostic } from "@yesimbot/agent-runtime";
import { AppError } from "@yesimbot/foundation";

import { reportedTaskFailure, TASK_ERRORS, taskError } from "./errors.js";

/** The runtime diagnostic of a failed worker turn: already classified, but its message and cause stay private. */
const TURN_DIAGNOSTICS = new WeakMap<AppError, { readonly diagnostic: AgentDiagnostic; readonly diagnosticId: string }>();

/** A worker turn that failed; its diagnostic is kept beside the error for {@link taskFailureReason}, never in its text. */
export function workerTurnFailed(diagnostic: AgentDiagnostic, diagnosticId: string): AppError {
  const error = taskError(TASK_ERRORS.task_worker_turn_failed, { effect: "unknown", detail: `diagnostic ${diagnosticId}` });
  TURN_DIAGNOSTICS.set(error, { diagnostic, diagnosticId });
  return error;
}

/**
 * Fixed classifications only; never expose provider prose, request bodies or stack/cause text. `activity` replaces the
 * closing advice with what the worker did (`WorkerActivity.summary`).
 */
export function taskFailureReason(error: unknown, activity?: string): string {
  if (error instanceof AppError && (error.code === TASK_ERRORS.task_model_not_allowed || error.code === TASK_ERRORS.task_model_unavailable))
    return reportedTaskFailure(error)!;
  const turn = error instanceof AppError ? TURN_DIAGNOSTICS.get(error) : undefined;
  const diagnostic = turn?.diagnostic;
  const failure = diagnostic?.modelFailure
    ? {
        kind: diagnostic.modelFailure,
        ...(Number.isInteger(diagnostic.status) && diagnostic.status! >= 100 && diagnostic.status! <= 599 ? { status: diagnostic.status } : {}),
      }
    : modelFailureInfo(error);
  const reason = failure
    ? modelFailureMessage(failure)
    : diagnostic?.name === "AgentProtocolError"
      ? "后台代理未成功提交终态报告。 [worker_report_not_accepted]"
      : (reportedTaskFailure(error) ?? "执行未完成。 [worker_failed]");
  const diagnosticId = turn && /^[a-zA-Z0-9_-]{1,128}$/.test(turn.diagnosticId) ? turn.diagnosticId : undefined;
  return `${reason}${diagnosticId ? ` 诊断编号：${diagnosticId}` : ""}\n${activity ?? "已执行的操作不会自动重跑；请先核实已完成的操作和工具结果。"}`;
}

/** A rejected model-authored report is a draft, not an accepted result or a raw service error. */
export function rejectedTaskReportDraft(result: string): string {
  let text = result.slice(0, 12000);
  for (const [name, secret] of Object.entries(process.env)) {
    if (secret && /key|token|secret|pass|credential|cookie/i.test(name)) {
      for (const value of [secret, encodeURIComponent(secret)]) text = text.split(value).join("[redacted]");
    }
  }
  return text
    .replace(/\b(?:bearer|basic)\s+\S+/gi, "[redacted]")
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|AIza)[\w-]+/g, "[redacted]")
    .replace(/((?:authorization|api[_-]?key|token|password|secret|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[redacted URL]";
      }
    })
    .slice(0, 2000);
}
