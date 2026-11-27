import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import vue from "@vitejs/plugin-vue";
import { build } from "vite";
import { expect, it } from "vitest";

import { vueFlags } from "../web/build-flags.mjs";

it("ships standalone routes on first load without a navigation chunk waterfall", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "yesimbot-route-bundle-"));
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await build({
      root: fileURLToPath(new URL("../web", import.meta.url)),
      configFile: false,
      logLevel: "silent",
      // Vitest sets NODE_ENV=test; compile SFCs exactly as the production build does.
      plugins: [vue({ isProduction: true })],
      // Measure what ships: vitest sets NODE_ENV=test, which would otherwise bundle Vue's dev build.
      mode: "production",
      define: { "process.env.NODE_ENV": JSON.stringify("production"), ...vueFlags },
      build: { outDir, emptyOutDir: true, target: "es2020", manifest: true, modulePreload: { polyfill: false } },
    });
    const manifest: Record<string, { dynamicImports?: string[] }> = JSON.parse(readFileSync(join(outDir, ".vite/manifest.json"), "utf8"));
    // This checks the emitted dependency graph, including shared helpers and CSS,
    // rather than just the source spelling of the route component declarations.
    // Routes stay eager; optional libraries load only when used: the remote desktop protocol when a desktop opens,
    // the highlighter and the CSV parser when the file viewer shows code or a table, the QR encoder when 安装 App shows a code.
    // qrcode's chunk is named after its entry file, lib/browser.js.
    const optional = ["rfb", "highlight.js", "papaparse", "_browser-"];
    const dynamic = Object.values(manifest).flatMap((chunk) => chunk.dynamicImports ?? []);
    expect(dynamic, JSON.stringify(manifest)).toHaveLength(optional.length);
    for (const name of optional)
      expect(
        dynamic.some((chunk) => chunk.includes(name)),
        `${name} in ${JSON.stringify(dynamic)}`,
      ).toBe(true);
    expect(
      Object.keys(manifest).filter(
        (key) =>
          key !== "index.html" &&
          !key.startsWith("_") &&
          !key.includes("@novnc/novnc/") &&
          !key.includes("highlight.js/") &&
          !key.includes("qrcode/") &&
          !key.endsWith(".woff2"),
      ),
    ).toEqual([]);
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
    expect(assets.some((asset) => asset.endsWith(".js"))).toBe(true);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    await rm(outDir, { recursive: true, force: true });
  }
}, 60_000);

it("navigates real eager routes without extra bootstrap or page API requests", async () => {
  const { createMemoryHistory } = await import("vue-router");
  const { createAppRouter } = await import("../web/src/router");
  const { createSession } = await import("../web/src/lib/session");
  const calls: string[] = [];
  const session = createSession(async (input) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify({
        authenticated: true,
        features: { napcat: true, accounts: true, tenant: false, usage: true, xiaoheihe: true },
        session: { username: "owner", role: "owner", expiresAt: Date.now() + 60_000 },
      }),
    );
  });
  const router = createAppRouter(session, createMemoryHistory());
  for (const path of ["/", "/instances", "/settings/system", "/settings/platforms", "/settings/reply", "/settings/extensions", "/settings/models"]) {
    await router.push(path);
    expect(router.currentRoute.value.path).toBe(path);
    expect(typeof router.currentRoute.value.matched.at(-1)!.components?.default).toBe("object");
  }
  expect(calls).toEqual(["/yesimbot/api/v1/bootstrap"]);
});
