import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeviceInvocation } from "@yesimbot/contracts";
import { expect, it } from "vitest";

import { LocalBrowserDriver, type BrowserPage } from "../src/drivers/browser.js";

// Explicit opt-in: always a disposable headless browser with a new profile, never a user's browser.
it.skipIf(!process.env.YESIMBOT_TEST_BROWSER)(
  "navigates, fills multiple real Chromium fields and submits with only two action calls",
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "yesimbot-browser-e2e-"));
    const submissions: string[] = [];
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (request.url?.startsWith("/search?")) {
        submissions.push(request.url);
        // Keep the old document visible beyond the quiet-period threshold while navigation is pending.
        setTimeout(() => response.end("<title>Search results</title><h1>Search completed</h1><a href='/'>Back</a>"), 500);
      } else
        response.end(
          "<title>Search form</title><form action='/search'><input name='q' placeholder='Query' value='old query'><input name='category' placeholder='Category' value='old category'><button>Search</button></form>",
        );
    });
    const chrome = spawn(
      process.env.YESIMBOT_TEST_BROWSER!,
      ["--headless", "--no-sandbox", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let driver: LocalBrowserDriver | undefined;
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        let stderr = "";
        const timeout = setTimeout(() => reject(new Error("test_browser_start_timeout")), 10_000);
        chrome.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        chrome.once("exit", () => {
          clearTimeout(timeout);
          reject(new Error("test_browser_exited"));
        });
        chrome.stderr.on("data", (chunk) => {
          stderr += String(chunk);
          const found = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);
          if (found) {
            clearTimeout(timeout);
            resolve(`http://127.0.0.1:${found[1]}/`);
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      driver = new LocalBrowserDriver(endpoint);
      const execute = async (input: unknown) => {
        const invocation = { input, conversation: { platform: "onebot" }, actors: [] } as unknown as DeviceInvocation;
        const result = await driver!.methods.execute!.execute(invocation, AbortSignal.timeout(10_000));
        expect(result.status).toBe("succeeded");
        return (result as { output: { tabs: Array<{ id: string }>; page: BrowserPage; completed: boolean; actionsCompleted: number } }).output;
      };
      const { tabs } = await execute({ action: "tabs" });
      const targetId = tabs[0].id;
      const navigation = await execute({ action: "navigate", targetId, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` });
      expect(navigation.page.title).toBe("Search form");
      const first = navigation.page;
      const query = first.elements.find((element) => element.name === "Query")!.ref;
      const category = first.elements.find((element) => element.name === "Category")!.ref;
      const search = first.elements.find((element) => element.name === "Search")!.ref;
      const sequence = await execute({
        action: "sequence",
        targetId,
        snapshot: first.snapshot,
        actions: [
          { action: "fill", ref: query, text: "中文 computer use" },
          { action: "fill", ref: category, text: "new category" },
          { action: "click", ref: search },
        ],
      });
      expect(sequence).toMatchObject({ completed: true, actionsCompleted: 3, page: { title: "Search results", settled: true } });
      expect(sequence.page.text).toContain("Search completed");
      expect(submissions).toHaveLength(1);
      const submitted = new URL(submissions[0]!, "http://localhost");
      expect(submitted.searchParams.get("q")).toBe("中文 computer use");
      expect(submitted.searchParams.get("category")).toBe("new category");
      // Reuse the returned result-page snapshot directly, without an inspect round trip.
      const back = sequence.page.elements.find((element) => element.name === "Back")!.ref;
      const returned = await execute({ action: "click", targetId, snapshot: sequence.page.snapshot, ref: back });
      expect(returned).toMatchObject({
        completed: true,
        page: { title: "Search form" },
      });
      const queryAgain = returned.page.elements.find((element) => element.name === "Query")!.ref;
      expect(
        await execute({
          action: "sequence",
          targetId,
          snapshot: returned.page.snapshot,
          actions: [
            { action: "fill", ref: queryAgain, text: "keyboard search" },
            { action: "press", key: "Enter" },
          ],
        }),
      ).toMatchObject({ completed: true, actionsCompleted: 2, page: { title: "Search results" } });
      expect(submissions).toHaveLength(2);
      expect(new URL(submissions[1]!, "http://localhost").searchParams.get("q")).toBe("keyboard search");
    } finally {
      await driver?.close();
      await new Promise<void>((resolve) => {
        if (chrome.exitCode !== null) resolve();
        else {
          chrome.once("exit", () => resolve());
          chrome.kill("SIGKILL");
        }
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  },
  20_000,
);

/** A disposable headless Chromium with a new profile; `close` ends it and removes the profile. */
async function launchBrowser() {
  const profile = await mkdtemp(join(tmpdir(), "yesimbot-browser-e2e-"));
  const chrome = spawn(
    process.env.YESIMBOT_TEST_BROWSER!,
    ["--headless", "--no-sandbox", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const close = async () => {
    await new Promise<void>((resolve) => {
      if (chrome.exitCode !== null) resolve();
      else {
        chrome.once("exit", () => resolve());
        chrome.kill("SIGKILL");
      }
    });
    await rm(profile, { recursive: true, force: true });
  };
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let stderr = "";
      const timeout = setTimeout(() => reject(new Error("test_browser_start_timeout")), 10_000);
      chrome.once("error", reject);
      chrome.once("exit", () => reject(new Error("test_browser_exited")));
      chrome.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        const found = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);
        if (found) {
          clearTimeout(timeout);
          resolve(`http://127.0.0.1:${found[1]}/`);
        }
      });
    });
    return { endpoint, close };
  } catch (error) {
    await close();
    throw error;
  }
}

it.skipIf(!process.env.YESIMBOT_TEST_BROWSER)(
  "lets the owner take over a real Chromium tab: click, select all, delete, type Chinese, submit, scroll and follow a new tab",
  async () => {
    const submissions: string[] = [];
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (request.url?.startsWith("/search?")) {
        submissions.push(request.url);
        response.end("<title>Results</title><h1>Results</h1>");
      } else if (request.url === "/next") response.end("<title>Next tab</title><h1>Next</h1>");
      else
        response.end(
          "<title>Form</title><body style='margin:0'><form action='/search'><input name='q' value='old text' style='position:absolute;left:0;top:0;width:300px;height:40px'></form>" +
            "<a href='/next' target='_blank' style='position:absolute;left:0;top:60px;font-size:30px'>open</a><div style='height:5000px'></div>" +
            "<script>addEventListener('scroll', () => (document.title = 'scrolled ' + scrollY))</script></body>",
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const chrome = await launchBrowser();
    const driver = new LocalBrowserDriver(chrome.endpoint);
    const conversation = {
      tenantId: "11111111-1111-4111-8111-111111111111",
      platform: "yesimbot-viewer",
      botId: "webui",
      kind: "direct",
      conversationId: "control",
    };
    const run = async (input: unknown, platform = "onebot") => {
      const invocation = {
        operationId: "22222222-2222-4222-8222-222222222222",
        capability: "computer.browser",
        method: "execute",
        input,
        conversation: platform === "onebot" ? { ...conversation, platform, botId: "bot", conversationId: "private:x" } : conversation,
        actors: [],
        expiresAt: Date.now() + 10_000,
      } as DeviceInvocation;
      const result = await driver.methods.execute!.execute(invocation, AbortSignal.timeout(10_000));
      expect(result.status).toBe("succeeded");
      return (result as { output: Record<string, unknown> }).output;
    };
    const control = (input: unknown) => run({ action: "control", input }, "yesimbot-viewer");
    const shown = async () => JSON.parse(((await run({ action: "view" }, "yesimbot-viewer")) as { text: string }).text) as { title: string; url: string };
    try {
      const { tabs } = (await run({ action: "tabs" })) as { tabs: Array<{ id: string }> };
      const port = (server.address() as { port: number }).port;
      await run({ action: "navigate", targetId: tabs[0]!.id, url: `http://127.0.0.1:${port}/` });
      expect((await shown()).title).toBe("Form");

      await control({ type: "click", x: 100, y: 20, button: "left" });
      await control({ type: "key", key: "ctrl+a" });
      await control({ type: "key", key: "BackSpace" });
      await control({ type: "text", text: "你好 world" });
      await control({ type: "key", key: "Return" });
      await expect.poll(() => submissions.length).toBe(1);
      expect(new URL(submissions[0]!, "http://localhost").searchParams.get("q")).toBe("你好 world");

      await run({ action: "navigate", targetId: tabs[0]!.id, url: `http://127.0.0.1:${port}/` });
      await control({ type: "scroll", x: 100, y: 200, dy: -3 });
      await expect.poll(async () => (await shown()).title).toMatch(/^scrolled [1-9]/);
      await control({ type: "scroll", x: 100, y: 200, dy: 3 });
      await expect.poll(async () => (await shown()).title).toBe("scrolled 0");

      // The link opens a new tab; the owner's view follows it.
      await control({ type: "click", x: 20, y: 75, button: "left" });
      await expect.poll(async () => (await shown()).title).toBe("Next tab");
    } finally {
      await driver.close();
      await chrome.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  30_000,
);
