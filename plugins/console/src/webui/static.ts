import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import type { Host, HttpContext } from "../host.js";

/** Paths owned by backends; never answered with the SPA document. */
export const BACKEND_PREFIXES = [
  "/yesimbot/api",
  "/yesimbot/admin",
  "/yesimbot/model-settings",
  "/yesimbot/napcat",
  "/yesimbot/wechat",
  "/yesimbot/account/runtime",
  "/yesimbot/tenant-assets",
  "/yesimbot/runtime",
  "/onebot",
  "/files",
  "/downloads",
  "/@",
];

/**
 * Where the public pages (about, privacy, terms) name this instance's contact: `webui.contactEmail`, or 本实例管理员 when
 * none is set. The pages ship without anyone's address (user, 2026-11-27: 联系邮箱「改成可配置」).
 */
export const CONTACT_MARK = "<!-- CONTACT -->";

const PUBLIC_PAGES = ["/about.html", "/privacy.html", "/terms.html"];

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export interface StaticAsset {
  body: Buffer;
  br?: Buffer;
  gzip?: Buffer;
  type: string;
  etag: string;
  immutable: boolean;
}

/** Reads a built app directory. `.br`/`.gz` siblings attach to their original file. */
export function loadAssets(root: string): Map<string, StaticAsset> {
  const assets = new Map<string, StaticAsset>();
  if (!existsSync(root)) return assets;
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const file = join(directory, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (!name.endsWith(".br") && !name.endsWith(".gz")) {
        const body = readFileSync(file);
        const path = "/" + relative(root, file).split(sep).join("/");
        assets.set(path, {
          body,
          br: existsSync(file + ".br") ? readFileSync(file + ".br") : undefined,
          gzip: existsSync(file + ".gz") ? readFileSync(file + ".gz") : undefined,
          type: TYPES[extname(name)] ?? "application/octet-stream",
          etag: etagOf(body),
          // Vite emits content-hashed names only under /assets.
          immutable: path.startsWith("/assets/"),
        });
      }
    }
  };
  walk(root);
  return assets;
}

/** Puts the contact into the public pages; their precompressed copies no longer match, so they go. */
export function fillContact(assets: Map<string, StaticAsset>, email: string): Map<string, StaticAsset> {
  const contact = email ? `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>` : "本实例管理员";
  for (const path of PUBLIC_PAGES) {
    const asset = assets.get(path);
    const text = asset?.body.toString("utf8");
    if (!asset || !text?.includes(CONTACT_MARK)) continue;
    const body = Buffer.from(text.replaceAll(CONTACT_MARK, contact));
    assets.set(path, { body, type: asset.type, etag: etagOf(body), immutable: asset.immutable });
  }
  return assets;
}

/** Returns the preferred supported encoding, honouring explicit q=0 refusals. */
export function chooseEncoding(header: string, asset: StaticAsset): "br" | "gzip" | undefined {
  const accepted = new Map<string, number>();
  for (const part of header.toLowerCase().split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    accepted.set(name, q ? Number(q.slice(2)) || 0 : 1);
  }
  const ok = (name: string) => (accepted.get(name) ?? accepted.get("*") ?? 0) > 0;
  if (asset.br && ok("br")) return "br";
  if (asset.gzip && ok("gzip")) return "gzip";
}

export function isBackendPath(path: string, extra: readonly string[] = []): boolean {
  return [...BACKEND_PREFIXES, ...extra].some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/"));
}

export function createStaticMiddleware(assets: Map<string, StaticAsset>, options: { excludedPrefixes?: readonly string[] } = {}) {
  const index = assets.get("/index.html");
  return async (http: HttpContext, next: () => Promise<unknown>) => {
    if (!["GET", "HEAD"].includes(http.method) || isBackendPath(http.path, options.excludedPrefixes)) return next();
    let asset = assets.get(http.path);
    if (!asset) {
      // Missing build files stay real 404s. Client routes may still contain dots
      // (session files are named `*.jsonl`), so only asset-like paths are excluded.
      if (!index || isAssetPath(http.path) || !http.accepts("html")) return next();
      asset = index;
    }
    http.set("Vary", "Accept-Encoding");
    http.set("ETag", asset.etag);
    // The shell may be shown from cache while it revalidates: every hashed asset an old
    // shell references stays deployed, and the origin round trip can take seconds.
    http.set("Cache-Control", asset.immutable ? "public, max-age=31536000, immutable" : "max-age=0, stale-while-revalidate=604800");
    http.set("X-Content-Type-Options", "nosniff");
    if (asset === index) http.set("X-Frame-Options", "DENY");
    if (http.get("if-none-match") === asset.etag) {
      http.status = 304;
      return;
    }
    const encoding = chooseEncoding(http.get("accept-encoding"), asset);
    http.status = 200;
    http.type = asset.type;
    if (encoding) http.set("Content-Encoding", encoding);
    const body = encoding ? asset[encoding]! : asset.body;
    // Koa omits the body for HEAD while keeping the representation headers.
    http.body = body;
    http.length = body.length;
  };
}

/** Inserts the middleware ahead of route parsing, failing closed on an unexpected server shape. */
export function installStatic(ctx: Host, assets: Map<string, StaticAsset>, options: { excludedPrefixes?: readonly string[] } = {}) {
  const remove = ctx.server.prepend(createStaticMiddleware(assets, options));
  ctx.on("dispose", remove);
}

function etagOf(body: Buffer): string {
  return `W/"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const isAssetPath = (path: string) => path.startsWith("/assets/") || extname(path).toLowerCase() in TYPES;
