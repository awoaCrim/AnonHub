import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { build as viteBuild } from "vite";

import { vueFlags } from "./web/build-flags.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));

// Standalone WebUI. dist/ holds nothing else, so stale files from older builds never ship.
rmSync(join(root, "dist"), { recursive: true, force: true });
export const webOutDir = join(root, "dist/app");
await viteBuild({
  root: join(root, "web"),
  base: "/",
  configFile: false,
  logLevel: "warn",
  plugins: [vue(), tailwindcss()],
  resolve: { alias: { "@": join(root, "web/src") } },
  define: vueFlags,
  build: { outDir: webOutDir, emptyOutDir: true, target: "es2020", sourcemap: false, modulePreload: { polyfill: false } },
});
// Public documents are rendered with the same shadcn components and compiled theme.
// Keep complete HTML available without JavaScript for OAuth verification and legal links.
const publicOut = join(root, ".tmp/public-render");
await viteBuild({
  root: join(root, "web"),
  configFile: false,
  logLevel: "warn",
  plugins: [vue()],
  define: vueFlags,
  build: { ssr: join(root, "web/public-render.ts"), outDir: publicOut, emptyOutDir: true, rollupOptions: { output: { entryFileNames: "render.mjs" } } },
});
const { renderDocuments } = await import(new URL("./.tmp/public-render/render.mjs", import.meta.url));
const css = /href="([^"]+\.css)"/.exec(readFileSync(join(webOutDir, "index.html"), "utf8"))?.[1];
if (!css) throw new Error("Missing shared UI stylesheet");
for (const [name, html] of Object.entries(await renderDocuments(css))) writeFileSync(join(webOutDir, `${name}.html`), html);
const noVnc = dirname(createRequire(import.meta.url).resolve("@novnc/novnc/package.json"));
const licenseFiles = readdirSync(join(noVnc, "docs")).filter((name) => name.startsWith("LICENSE."));
writeFileSync(
  join(webOutDir, "novnc-LICENSE.txt"),
  [
    "noVNC 1.5.0 — unmodified upstream library; source: https://github.com/novnc/noVNC/tree/v1.5.0\n",
    readFileSync(join(noVnc, "AUTHORS"), "utf8"),
    ...licenseFiles.map((name) => `\n${name}\n${readFileSync(join(noVnc, "docs", name), "utf8")}`),
  ].join("\n"),
);
precompress(webOutDir);

/** Writes .br/.gz siblings so the server never compresses on the request path. */
function precompress(directory) {
  for (const name of readdirSync(directory)) {
    const file = join(directory, name);
    if (statSync(file).isDirectory()) precompress(file);
    else if (/\.(js|mjs|css|html|svg|json|txt)$/.test(name)) {
      const body = readFileSync(file);
      writeFileSync(`${file}.br`, brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
      writeFileSync(`${file}.gz`, gzipSync(body, { level: 9 }));
    }
  }
}
