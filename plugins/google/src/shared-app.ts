import { readFileSync, statSync } from "node:fs";

import type { GoogleConfig } from "./config.js";
import { validRedirect } from "./connector.js";

/** Where a friend's runtime finds the owner's shared Google app (a read-only mount kept current by the account manager). */
export const SHARED_APP_FILE = process.env.YESIMBOT_GOOGLE_APP_FILE || "/run/yesimbot/policy/google.json";
const MEMBER = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Friends never set up a Google app of their own: their runtime always uses the owner's. */
export function usesSharedApp(): boolean {
  return MEMBER.test(process.env.YESIMBOT_TENANT_ID ?? "");
}

/** The shared app as published, re-read when the file changes; anything unreadable or malformed means "not set up". */
export function sharedAppReader(file = SHARED_APP_FILE): () => GoogleConfig {
  let seen = "",
    app: GoogleConfig = {};
  return () => {
    try {
      const stat = statSync(file);
      const key = `${stat.mtimeMs}:${stat.size}`;
      if (key === seen) return app;
      seen = key;
      app = {};
      if (!stat.isFile() || stat.size > 4096) return app;
      const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const text = (field: unknown) => typeof field === "string" && field.length > 0 && field.length <= 512 && !/[\s\p{Cc}]/u.test(field);
      if (value?.version === 1 && text(value.clientId) && text(value.clientSecret) && text(value.redirectUri) && validRedirect(value.redirectUri as string))
        app = { clientId: value.clientId as string, clientSecret: value.clientSecret as string, redirectUri: value.redirectUri as string };
    } catch {
      seen = "";
      app = {};
    }
    return app;
  };
}
