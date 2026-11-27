import { createHmac } from "node:crypto";

import { safeEqual } from "@yesimbot/foundation";

import { memberId } from "./accounts.js";

/** The manager binds the parent-selected display name to its private child cookie. This never
 * selects a runtime/user ID. Browser-supplied relay headers are stripped at both relay boundaries. */
export function relayChatUsername(http: { get(name: string): string }, fallback: string): string {
  // On a standalone owner runtime the browser owns its cookie: it cannot supply a display name.
  // Isolated children only receive the manager's server-held owner cookie through the relay.
  if (!memberId.test(process.env.YESIMBOT_TENANT_ID ?? "")) return fallback;
  const name = http.get("x-yesimbot-chat-name");
  const proof = http.get("x-yesimbot-chat-proof");
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(name) || !/^[a-f0-9]{64}$/.test(proof)) return fallback;
  const expected = createHmac("sha256", http.get("cookie")).update(`web-chat:${name}`).digest("hex");
  if (!safeEqual(expected, proof, { length: 64 })) return fallback;
  const username = Buffer.from(name, "base64url").toString("utf8");
  return username && username.length <= 256 ? username : fallback;
}
