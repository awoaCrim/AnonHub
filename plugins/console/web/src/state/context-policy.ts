import { api } from "../lib/api";
import { createConfigFieldsEditor } from "./config-fields";

/** The existing behavior editor keeps shared session settings on the administrator's server. */
export function createContextPolicyEditor(request: typeof api = api) {
  return createConfigFieldsEditor(["session"], {
    savedNotice: "",
    // Reads follow the editor (cached when it asks, fresh when it rereads); a save is never cached.
    request: (async (_path, body, options) => {
      const input = body as { revision: string; config: { session: Record<string, unknown> } } | undefined;
      const result = await request<{ revision: string; policy: { session: Record<string, unknown> } }>(
        "/yesimbot/admin/context-policy",
        input ? { revision: input.revision, session: input.config.session } : undefined,
        input ? undefined : options,
      );
      return { revision: result.revision, config: { session: result.policy.session } };
    }) as typeof api,
  });
}
