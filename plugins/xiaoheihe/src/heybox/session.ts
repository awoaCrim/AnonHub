import { chmod, lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { AppError, readJson, writeFileAtomic, type Parser } from "@yesimbot/foundation";

import { isXiaoheiheCookie, type StoredCookie } from "./http.js";

/** The one format of `session.json`; a cookie of another shape makes the whole file invalid. */
const SESSION_FILE: Parser<StoredSession> = {
  parse(value) {
    const session = value as Partial<StoredSession> | null;
    if (
      !session ||
      typeof session.user_id !== "string" ||
      !session.user_id ||
      !Array.isArray(session.cookies) ||
      session.cookies.some((cookie) => !cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string")
    )
      throw new AppError("session_invalid", { effect: "none" });
    return { user_id: session.user_id, cookies: session.cookies };
  },
};

/** Same layout as xiaoheihe-cli's `session.json`, so an existing login can be copied over as is. */
export interface StoredSession {
  user_id: string;
  cookies: StoredCookie[];
}

export async function loadSession(file: string): Promise<StoredSession | undefined> {
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new AppError("session_file_symlink", { effect: "none" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error instanceof AppError ? error : new AppError("session_unreadable", { effect: "none", cause: error });
  }
  let session: StoredSession | undefined;
  try {
    session = await readJson(file, SESSION_FILE);
  } catch (error) {
    // `readJson` reports text that is not JSON, or JSON in another shape, as `data_invalid`.
    throw new AppError(error instanceof AppError && error.code === "data_invalid" ? "session_invalid" : "session_unreadable", { effect: "none", cause: error });
  }
  return session && { user_id: session.user_id, cookies: session.cookies.filter(isXiaoheiheCookie) };
}

/** Private (0600 in a 0700 directory) and atomic; refuses symlinks. */
export async function saveSession(file: string, session: StoredSession): Promise<void> {
  const cookies = session.cookies.filter(isXiaoheiheCookie);
  if (!session.user_id || !cookies.length) throw new AppError("session_invalid", { effect: "none" });
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const existing = await lstat(file).catch(() => undefined);
  if (existing?.isSymbolicLink()) throw new AppError("session_file_symlink", { effect: "none" });
  await writeFileAtomic(file, JSON.stringify({ user_id: session.user_id, cookies }), { mode: 0o600 });
}

/** The web login sets ids and keys under two alias names each; keep both in sync. */
export function normalizeCookies(cookies: readonly StoredCookie[], result: { heybox_id?: unknown; pkey?: unknown } = {}): StoredCookie[] {
  const own = cookies.filter(isXiaoheiheCookie);
  const named = new Map(own.map((cookie) => [cookie.name, cookie.value]));
  const user = String(result.heybox_id ?? named.get("user_heybox_id") ?? named.get("heybox_id") ?? "");
  const pkey = typeof result.pkey === "string" ? result.pkey : (named.get("user_pkey") ?? named.get("pkey"));
  const aliases: Record<string, string | undefined> = { user_heybox_id: user || undefined, heybox_id: user || undefined, user_pkey: pkey, pkey };
  return [
    ...own.filter((cookie) => !(cookie.name in aliases)),
    ...Object.entries(aliases).flatMap(([name, value]) => (value ? [{ name, value, domain: ".xiaoheihe.cn", path: "/", secure: true }] : [])),
  ];
}
