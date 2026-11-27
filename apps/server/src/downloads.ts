import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { AppError, resolveInside } from "@yesimbot/foundation";

import type { HttpServer } from "./http.js";

/**
 * The manifests, read fresh every time: `client.json` (the device client; clients and the console read it) and
 * `android.json` (the phone app; the console's 安装 App and the app's own update check read it).
 */
const MANIFESTS = new Set(["client.json", "android.json"]);
/** Packages by extension; their names carry their hash, so they are cached for good. */
const PACKAGES: Record<string, string> = { zip: "application/zip", apk: "application/vnd.android.package-archive" };
const PACKAGE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(zip|apk)$/;
const NOT_THERE = new Set(["path_missing", "path_is_link", "path_outside_root"]);

/**
 * Serves the site's published files from `<state>/downloads/` at `/downloads/<name>`: the manifests, never cached,
 * and the packages (device-client ZIPs, the Android APK), cached for good. Anything else is a 404.
 */
export function serveDownloads(http: HttpServer, stateDir: string): () => void {
  const root = join(stateDir, "downloads");
  return http.get("/downloads/:name", async (context) => {
    const name = context.params.name ?? "";
    const packageType = PACKAGES[PACKAGE.exec(name)?.[1] ?? ""];
    if (!MANIFESTS.has(name) && !packageType) return;
    let file: string;
    try {
      file = await resolveInside(root, name, { links: "reject" });
    } catch (error) {
      if ((error instanceof AppError && NOT_THERE.has(error.code)) || (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const info = await stat(file);
    if (!info.isFile()) return;
    context.set("X-Content-Type-Options", "nosniff");
    if (packageType) {
      context.type = packageType;
      context.set("Content-Disposition", "attachment");
      context.set("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      context.type = "application/json; charset=utf-8";
      context.set("Cache-Control", "no-store");
    }
    context.length = info.size;
    context.body = createReadStream(file);
  });
}
