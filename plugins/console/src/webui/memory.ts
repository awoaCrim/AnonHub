import { readAdminLoginBody, type AdminAuth } from "../admin-auth.js";
import type { Host } from "../host.js";
import type { MemoryService } from "../memory-service.js";
import { sendStoredFile } from "./chat-attachments.js";
import { authorizeOwner } from "./plugins.js";

export const MEMORY_ATTACHMENT_PATH = "/yesimbot/api/v1/memory/attachment";

/** The service is resolved in this runtime; callers cannot select another tenant. */
export function installMemory(ctx: Host, auth: AdminAuth) {
  const path = "/yesimbot/api/v1/memory";
  const service = () => ctx.get("yesimbotMemory") as MemoryService | undefined;
  ctx.server.get(path, async (http) => {
    if (!authorizeOwner(http, auth)) return;
    const memory = service();
    if (!memory) {
      http.status = 503;
      http.body = { message: "memory_unavailable" };
      return;
    }
    try {
      const cursor = typeof http.query.cursor === "string" ? http.query.cursor : undefined;
      const result = await memory.list({ limit: 200, cursor });
      if (authorizeOwner(http, auth)) http.body = result;
    } catch {
      if (!authorizeOwner(http, auth)) return;
      http.status = 400;
      http.body = { message: "memory_read_failed" };
    }
  });
  ctx.server.get(MEMORY_ATTACHMENT_PATH, async (http) => {
    if (!authorizeOwner(http, auth)) return;
    const memory = service();
    const { id, index } = http.query;
    if (!memory?.attachment || typeof id !== "string" || id.length > 256 || typeof index !== "string" || !/^[1-9]\d{0,5}$/.test(index)) {
      http.status = 404;
      http.body = { message: "attachment_not_found" };
      return;
    }
    try {
      const file = await memory.attachment(id, Number(index));
      // A memory's attachment never changes under its index (indexes are not reused).
      if (authorizeOwner(http, auth)) sendStoredFile(http, file.bytes, file.filename, http.query.download === "1", true);
    } catch {
      if (!authorizeOwner(http, auth)) return;
      http.status = 404;
      http.body = { message: "attachment_not_found" };
    }
  });
  ctx.server.post(path, async (http) => {
    if (!authorizeOwner(http, auth, true)) return;
    const cookie = http.get("cookie");
    const session = auth.sessionFromCookie(cookie);
    const ensure = () => {
      if (!authorizeOwner(http, auth, true)) throw Error("memory_authentication_required");
      if (auth.sessionFromCookie(cookie) !== session) {
        http.status = 401;
        http.body = { message: "login_required" };
        throw Error("memory_authentication_required");
      }
    };
    try {
      const input = (await readAdminLoginBody(http, 32 * 1024)) as Record<string, unknown>;
      if (
        !input ||
        typeof input !== "object" ||
        typeof input.id !== "string" ||
        !input.id ||
        input.id.length > 256 ||
        !Number.isSafeInteger(input.revision) ||
        (input.revision as number) < 0
      )
        throw Error("invalid_memory_request");
      ensure();
      const memory = service();
      if (!memory) throw Error("memory_unavailable");
      const identity = { id: input.id, revision: input.revision as number };
      let result: unknown;
      if (input.action === "delete") result = await memory.delete(identity, ensure);
      else if (
        input.action === "update" &&
        typeof input.content === "string" &&
        (input.visibility === undefined || ["owner", "conversation", "shared"].includes(String(input.visibility)))
      )
        result = await memory.update(
          {
            ...identity,
            content: input.content,
            ...(input.visibility !== undefined ? { visibility: input.visibility as "owner" | "conversation" | "shared" } : {}),
          },
          ensure,
        );
      else throw Error("invalid_memory_request");
      ensure();
      http.body = result;
    } catch (error) {
      try {
        ensure();
      } catch {
        return;
      }
      const code = error instanceof Error ? error.message : "";
      http.status = code === "memory_revision_conflict" ? 409 : code === "memory_unavailable" ? 503 : 400;
      http.body = {
        message: ["memory_revision_conflict", "memory_not_found", "invalid_memory_visibility", "invalid_memory_content", "memory_unavailable"].includes(code)
          ? code
          : "invalid_memory_request",
      };
    }
  });
}
