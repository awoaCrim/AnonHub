import { TASK_ERRORS, taskError } from "./errors.js";

/** Instance-owned model policy. An empty list follows the conversation's effective model. */
export function taskModelChoices(configured: readonly string[] | undefined, current: string | undefined): string[] {
  return configured?.length ? [...configured] : current ? [current] : [];
}

/** Never substitute another route for a pinned or explicitly requested model. */
export function selectTaskModel(choices: readonly string[], requested?: string, registered?: readonly string[]): string {
  const selected = requested ?? choices[0];
  if (!selected) throw taskError(TASK_ERRORS.task_model_unavailable);
  if (!choices.includes(selected)) throw taskError(TASK_ERRORS.task_model_not_allowed);
  if (registered && !registered.includes(selected)) throw taskError(TASK_ERRORS.task_model_unavailable);
  return selected;
}
