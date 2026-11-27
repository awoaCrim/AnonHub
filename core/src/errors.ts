import { errorEntry } from "@yesimbot/foundation";

/**
 * The registered Chinese text for a person (convention 01) when `cause` is an `AppError` with a registered code; matched
 * by name so an error from another loaded copy of Core still counts. Detail and cause stay in the log.
 */
export function errorUserText(cause: unknown): string | undefined {
  if (!(cause instanceof Error) || cause.name !== "AppError") return undefined;
  const code: unknown = (cause as { code?: unknown }).code;
  return typeof code === "string" ? errorEntry(code)?.user : undefined;
}
