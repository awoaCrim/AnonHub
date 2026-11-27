import { chromium } from "playwright-core";

export const LIMITS = Object.freeze({ htmlBytes: 200_000, imageBytes: 5 * 1024 * 1024, minWidth: 480, maxWidth: 1440, maxHeight: 8000, timeoutMs: 20_000 });
// This policy precedes all supplied markup. Additional policies can only restrict it.
const CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";

export class RenderError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.status = status;
  }
}

export function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["html", "width"].includes(key)))
    throw new RenderError("invalid_input");
  if (typeof input.html !== "string" || !input.html.trim() || Buffer.byteLength(input.html) > LIMITS.htmlBytes) throw new RenderError("invalid_html");
  const width = input.width ?? 1000;
  if (!Number.isSafeInteger(width) || width < LIMITS.minWidth || width > LIMITS.maxWidth) throw new RenderError("invalid_width");
  return { html: input.html, width };
}

export async function launchBrowser(executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium") {
  return chromium.launch({
    executablePath,
    headless: true,
    // The unprivileged, network-less container is the OS isolation boundary.
    // Do not grant it the additional capabilities required by Chromium's sandbox.
    chromiumSandbox: false,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-extensions",
      "--disable-sync",
      "--no-first-run",
      "--disable-dev-shm-usage",
    ],
    timeout: LIMITS.timeoutMs,
  });
}

/** One fresh context per request; never navigate to supplied URLs. */
export async function preparePage(browser, input) {
  const { html, width } = validateInput(input);
  const context = await browser.newContext({
    javaScriptEnabled: false,
    serviceWorkers: "block",
    acceptDownloads: false,
    permissions: [],
    viewport: { width, height: 600 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  try {
    // Covers HTTP, local services, file URLs, redirects and child-frame requests.
    // Data URLs are handled inside the renderer and allowed only for images/fonts by CSP.
    await context.route("**/*", (route) => route.abort("blockedbyclient"));
    const page = await context.newPage();
    page.setDefaultTimeout(LIMITS.timeoutMs);
    page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
    await page.setContent(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">${html}`, {
      waitUntil: "load",
      timeout: LIMITS.timeoutMs,
    });
    await page.evaluate(() => document.fonts.ready);
    const height = await page.evaluate(() =>
      Math.ceil(
        Math.max(
          document.body?.scrollHeight ?? 0,
          document.documentElement.scrollHeight,
          document.body?.offsetHeight ?? 0,
          document.documentElement.offsetHeight,
          document.body?.clientHeight ?? 0,
          document.documentElement.clientHeight,
        ),
      ),
    );
    if (height > LIMITS.maxHeight) throw new RenderError("document_too_tall");
    return { context, page, width, height: Math.max(1, height) };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

export async function renderHtml(browser, input) {
  const { context, page, width, height } = await preparePage(browser, input);
  try {
    // Full-page capture honors the bounded document clip beyond the initial
    // viewport without changing CSS viewport units or responsive layout.
    const bytes = await page.screenshot({
      type: "png",
      fullPage: true,
      clip: { x: 0, y: 0, width, height },
      animations: "disabled",
      timeout: LIMITS.timeoutMs,
    });
    if (bytes.byteLength > LIMITS.imageBytes) throw new RenderError("image_too_large");
    return bytes;
  } finally {
    await context.close().catch(() => {});
  }
}
