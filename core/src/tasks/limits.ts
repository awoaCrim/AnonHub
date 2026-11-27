/** Bounds of the time limit the main conversation gives a task. */
export const TASK_MINUTES = { min: 5, max: 480 } as const;

/**
 * Tasks in a row that carry on unfinished work without the user (each created in the turn that received the
 * previous one's result). The bot keeps pushing (user, 2026-11-17: 「除非阻塞无法完成，不然都可以自己继续往下推进」),
 * but a chain this long stops and reports instead of looping. A user message starts a new chain.
 */
export const MAX_TASK_CONTINUATIONS = 5;
