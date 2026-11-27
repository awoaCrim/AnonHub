import { z } from "zod/v4";

import { readOnlyCommand } from "./shell-command.js";

// Read-only forms of the mixed desktop/browser tools. Strict parsing means a call that
// smuggles an action past the schema is not an observation.
const schemas: Record<string, z.ZodTypeAny> = {
  computer_ui: z
    .object({
      // `describe` only reads the tool catalog.
      tool: z.enum(["describe", "snapshot", "find", "screenshot", "list_apps", "list_windows", "list_displays", "clipboard_get"]),
      args: z
        .object({
          app: z.string().optional(),
          // agent-desktop window ids are strings (`w-1.231-…` on Linux); one picks a window when an app has several.
          window_id: z.union([z.string().min(1).max(256), z.number().int()]).optional(),
          role: z.string().optional(),
          name: z.string().optional(),
          tool: z.string().max(64).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  computer_browser: z.object({ action: z.enum(["tabs", "inspect", "screenshot"]), targetId: z.string().optional() }).strict(),
  // Reading or waiting for a background command changes nothing; stopping it does.
  computer_job: z
    .object({
      action: z.enum(["read", "list"]),
      jobId: z.string().optional(),
      waitMs: z.number().int().optional(),
      offset: z.number().int().optional(),
    })
    .strict(),
  // Without `deviceId` it only lists the computers and which one is in use.
  computer_switch: z.object({}).strict(),
  // A command that only reads (`ls`, `cat`, `stat`, `systemctl status`…), in the foreground.
  computer_exec: z
    .object({
      command: z.string().min(1).max(65536).refine(readOnlyCommand),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().optional(),
      background: z.literal(false).optional(),
    })
    .strict(),
};

/** Whether a computer call only observes; after an unknown effect a worker may still observe to verify it. */
export function computerObservationAllowed(name: string, input: unknown): boolean {
  return schemas[name]?.safeParse(input).success ?? false;
}
