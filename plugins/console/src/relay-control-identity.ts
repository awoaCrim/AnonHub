import { createHmac } from "node:crypto";

import { safeEqual, contentHash } from "@yesimbot/foundation";

/** The parent login stays distinct when the manager replaces it with its shared child cookie. */
export function controlLoginFingerprint(http: { get(name: string): string }): string {
  const cookie = http.get("cookie");
  const fallback = contentHash(cookie);
  if (!process.env.YESIMBOT_TENANT_ID && process.env.YESIMBOT_MANAGED_CONTEXT !== "1") return fallback;
  const login = http.get("x-yesimbot-control-login"),
    proof = http.get("x-yesimbot-control-proof");
  if (!/^[a-f0-9]{64}$/.test(login) || !/^[a-f0-9]{64}$/.test(proof)) return fallback;
  const expected = createHmac("sha256", cookie).update(`desktop-login:${login}`).digest("hex");
  return safeEqual(expected, proof, { length: 64 }) ? login : fallback;
}
