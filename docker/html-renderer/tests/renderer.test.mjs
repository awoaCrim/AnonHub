import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { launchBrowser, LIMITS, preparePage, renderHtml, validateInput } from "../renderer.mjs";
import { createServer } from "../server.mjs";

let browser;
before(async () => {
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXYsAAAAASUVORK5CYII=", "base64");

test("renders Chinese HTML into a bounded PNG without depending on a desktop", async () => {
  const bytes = await renderHtml(browser, {
    html: "<style>body{font-family:sans-serif;background:#fcf6eb}h1{color:#123456}</style><h1>昨日 AI 资讯早报</h1><p>用于静态渲染验收的合成内容</p>",
    width: 800,
  });
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(bytes.readUInt32BE(16), 800);
  assert.ok(bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= LIMITS.maxHeight);
  assert.ok(bytes.byteLength > 1000 && bytes.byteLength < LIMITS.imageBytes);
  // Each render closes its isolated context.
  assert.equal(browser.contexts().length, 0);
});

test("captures the complete long document beyond the initial viewport at the requested width", async () => {
  const html =
    "<style>body{margin:0}article{height:1700px;background:linear-gradient(#fff,#ddd)}footer{height:80px;background:#f00}aside{width:5000px;height:10px}</style><article>长文顶部</article><footer>底部完整标记</footer><aside></aside>";
  const { context, height } = await preparePage(browser, { html, width: 800 });
  await context.close();
  assert.equal(height, 1790);
  const bytes = await renderHtml(browser, { html, width: 800 });
  assert.equal(bytes.readUInt32BE(16), 800);
  assert.equal(bytes.readUInt32BE(20), height);
  assert.equal(browser.contexts().length, 0);
});

test("blocks scripts, handlers, frames, stylesheets and HTTP/file resource reads in the actual browser", async () => {
  let requests = 0;
  const trap = http.createServer((_request, response) => {
    requests++;
    response.end(PNG);
  });
  trap.listen(0, "127.0.0.1");
  await once(trap, "listening");
  const url = `http://127.0.0.1:${trap.address().port}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), "renderer-proof-"));
  const file = path.join(directory, "secret.png");
  await writeFile(file, PNG);
  const { context, page } = await preparePage(browser, {
    html: `
    <meta http-equiv="Content-Security-Policy" content="default-src * data: 'unsafe-inline'">
    <script>globalThis.executed=true;fetch('${url}/script')</script>
    <link rel="stylesheet" href="${url}/sheet">
    <style>@import url('${url}/import');body{background-image:url('${url}/css')}</style>
    <body onload="globalThis.executed=true"><h1 id="title">静态内容</h1>
    <img id="remote" src="${url}/image" onerror="globalThis.executed=true">
    <img id="local" src="file://${file}">
    <img id="data" src="data:image/png;base64,${PNG.toString("base64")}">
    <iframe src="${url}/frame"></iframe><iframe src="file://${file}"></iframe>
    <iframe srcdoc="<script>parent.executed=true</script>"></iframe>
    <object data="file://${file}"></object>
    <svg><image href="${url}/svg"/></svg>
  `,
    width: 700,
  });
  try {
    assert.equal(await page.evaluate(() => globalThis.executed), undefined);
    assert.equal(await page.locator("#title").textContent(), "静态内容");
    assert.deepEqual(await page.evaluate(() => ["remote", "local", "data"].map((id) => document.getElementById(id).naturalWidth)), [0, 0, 1]);
    assert.ok(page.frames().every((frame) => ["", "about:blank", "about:srcdoc", "chrome-error://chromewebdata/"].includes(frame.url())));
    assert.equal(requests, 0);
  } finally {
    await context.close();
    trap.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not follow document redirects or retain data between requests", async () => {
  let requests = 0;
  const trap = http.createServer((_request, response) => {
    requests++;
    response.end("not allowed");
  });
  trap.listen(0, "127.0.0.1");
  await once(trap, "listening");
  try {
    // Chromium may reject this document while aborting its main-frame navigation.
    // A failed render is acceptable; opening the supplied URL is not.
    const prepared = await preparePage(browser, {
      html: `<meta http-equiv="refresh" content="0;url=http://127.0.0.1:${trap.address().port}/"><script>localStorage.setItem('leak','yes')</script><p>safe</p>`,
    }).catch(() => undefined);
    if (prepared) {
      try {
        await prepared.page.waitForTimeout(100);
        assert.ok(["about:blank", "chrome-error://chromewebdata/"].includes(prepared.page.url()));
      } finally {
        await prepared.context.close();
      }
    }
    assert.equal(requests, 0);
    assert.equal(browser.contexts().length, 0);
  } finally {
    trap.close();
  }
  const next = await preparePage(browser, { html: "<p>fresh</p>" });
  try {
    assert.equal(await next.page.evaluate(() => globalThis.executed), undefined);
  } finally {
    await next.context.close();
  }
});

test("rejects oversized content and invalid dimensions, and closes contexts on errors", async () => {
  for (const input of [
    { html: "" },
    { html: "中".repeat(70_000) },
    { html: "x", width: 1441 },
    { html: "x", width: 700.1 },
    { html: "x", url: "http://localhost" },
  ]) {
    assert.throws(() => validateInput(input));
  }
  await assert.rejects(() => renderHtml(browser, { html: "<div style='height:9000px'>too tall</div>" }), /document_too_tall/);
  assert.equal(browser.contexts().length, 0);
});

test("serves only the existing render contract and health endpoint over a Unix socket", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "renderer-http-"));
  const socketPath = path.join(directory, "http.sock");
  const server = createServer(browser);
  server.listen(socketPath);
  await once(server, "listening");
  async function request(method, requestPath, body, contentType = "application/json") {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath, method, path: requestPath, headers: { "content-type": contentType } }, async (res) => {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({ status: res.statusCode, type: res.headers["content-type"], bytes: Buffer.concat(chunks) });
      });
      req.on("error", reject);
      req.end(body);
    });
  }
  try {
    assert.equal((await request("GET", "/health")).status, 200);
    assert.equal((await request("GET", "/render")).status, 404);
    assert.equal((await request("POST", "/render", "bad", "text/html")).status, 415);
    assert.equal((await request("POST", "/render", "bad")).status, 400);
    assert.equal((await request("POST", "/render", JSON.stringify({ html: "<p>test</p>", width: 100 }))).status, 400);
    // An interrupted upload must release the slot for the next independent render.
    const interrupted = http.request({ socketPath, method: "POST", path: "/render", headers: { "content-type": "application/json", "content-length": 10000 } });
    const closed = new Promise((resolve) => interrupted.once("close", resolve));
    interrupted.on("error", () => {});
    interrupted.write("{");
    await new Promise((resolve) => setTimeout(resolve, 30));
    interrupted.destroy();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const result = await request("POST", "/render", JSON.stringify({ html: "<h1>合成日报</h1>", width: 640 }));
    assert.equal(result.status, 200);
    assert.equal(result.type, "image/png");
    assert.equal(result.bytes.readUInt32BE(16), 640);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
