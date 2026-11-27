import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeviceInvocation, OperationResult } from "@yesimbot/contracts";
import { expect, it } from "vitest";

import { LocalBrowserDriver, type BrowserPage } from "../src/drivers/browser.js";
import { conversationWorkspace } from "../src/drivers/files.js";

// User, 2026-11-20: 「允许部署客户端」 — the bot's own account asked for file uploads, typing into web terminals
// (xterm, canvases) and the wheel over one part of a page. Opt-in: a disposable headless browser, never a user's.
const PAGE = `<title>Console</title>
<style>body{margin:0;height:3000px} #term{width:400px;height:120px;background:#000;color:#0f0} #list{position:absolute;left:0;top:200px;width:300px;height:100px;overflow:auto} #list div{height:40px}</style>
<div id="term" tabindex="0"></div>
<div id="list">${Array.from({ length: 20 }, (_, index) => `<div>row ${index}</div>`).join("")}</div>
<div style="position:absolute;top:340px">
  <input type="file" id="field" aria-label="Attachment" multiple>
  <input type="file" id="hidden" style="display:none">
  <button id="pick" aria-label="Choose file">Choose file</button>
  <p id="files"></p><p id="keys"></p><p id="scrolled"></p>
</div>
<script>
  const keys = [];
  // Like xterm: keys arrive as keydown on a focused element, not as an input's value.
  term.addEventListener("keydown", (event) => { keys.push((event.ctrlKey ? "ctrl+" : "") + event.key); document.getElementById("keys").textContent = keys.join("|"); event.preventDefault(); });
  term.addEventListener("click", () => term.focus());
  const show = (input) => input.addEventListener("change", () => { document.getElementById("files").textContent = input.id + ":" + [...input.files].map((file) => file.name + "/" + file.size).join(","); });
  show(field); show(hidden);
  pick.addEventListener("click", () => hidden.click());
  list.addEventListener("scroll", () => { document.getElementById("scrolled").textContent = "list " + list.scrollTop + " page " + scrollY; });
</script>`;

it.skipIf(!process.env.YESIMBOT_TEST_BROWSER)(
  "types into a terminal, sends key combos, scrolls one region, and uploads files from the conversation's folder",
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "yesimbot-browser-input-"));
    const root = await mkdtemp(join(tmpdir(), "yesimbot-browser-files-"));
    const conversation = { tenantId: "00000000-0000-4000-8000-000000000000", botId: "bot", platform: "onebot", kind: "direct" as const, conversationId: "u1" };
    const folder = conversationWorkspace(root, conversation);
    await mkdir(join(folder, "out"), { recursive: true });
    await writeFile(join(folder, "out", "report.txt"), "hello");
    await writeFile(join(folder, "photo.png"), "12345678");
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(PAGE);
    });
    const chrome = spawn(
      process.env.YESIMBOT_TEST_BROWSER!,
      [
        "--headless",
        "--no-sandbox",
        "--window-size=800,600",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let driver: LocalBrowserDriver | undefined;
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        let stderr = "";
        const timeout = setTimeout(() => reject(new Error("test_browser_start_timeout")), 10_000);
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
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      driver = new LocalBrowserDriver(endpoint, { workspaceRoot: root });
      const run = async (input: unknown): Promise<OperationResult> =>
        driver!.methods.execute!.execute({ input, conversation, actors: [] } as unknown as DeviceInvocation, AbortSignal.timeout(20_000));
      const execute = async (input: unknown) => {
        const result = await run(input);
        expect(result.status).toBe("succeeded");
        return (result as { output: Record<string, unknown> & { tabs: Array<{ id: string }>; page: BrowserPage; text: string } }).output;
      };
      const targetId = (await execute({ action: "tabs" })).tabs[0]!.id;
      await execute({ action: "navigate", targetId, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` });
      const scale = JSON.parse((await execute({ action: "screenshot", targetId })).text).scale as number;
      const at = (x: number, y: number) => ({ x: Math.round(x * scale), y: Math.round(y * scale) });

      // A terminal: focus it with a click, then type a command line and Ctrl+C.
      await execute({ action: "click_at", targetId, ...at(200, 60) });
      const typed = await execute({ action: "type", targetId, text: "ls -la\n" });
      // A fresh screenshot comes back, its facts in the text: a terminal's output is not in the page text.
      expect(typed).toMatchObject({ mediaType: "image/jpeg" });
      expect(JSON.parse(typed.text)).toMatchObject({ action: "type", completed: true, charactersSent: 7, totalCharacters: 7 });
      expect(JSON.parse((await execute({ action: "hotkey", targetId, keys: "ctrl+c" })).text)).toMatchObject({ completed: true, actionsCompleted: 1 });
      let page = (await execute({ action: "inspect", targetId })) as unknown as BrowserPage;
      expect(page.text).toContain("l|s| |-|l|a|Enter|ctrl+c");

      // The wheel over the list scrolls the list, not the page.
      expect(JSON.parse((await execute({ action: "scroll", targetId, ...at(150, 250), dy: 2 })).text)).toMatchObject({ action: "scroll", completed: true });
      page = (await execute({ action: "inspect", targetId })) as unknown as BrowserPage;
      expect(page.text).toContain("list 200 page 0");
      const field = page.elements.find((element) => element.name === "Attachment")!.ref;
      const button = page.elements.find((element) => element.name === "Choose file")!.ref;

      // A file field takes the files directly, relative to the conversation's folder or absolute inside it.
      const direct = await execute({ action: "upload", targetId, ref: field, files: ["out/report.txt", join(folder, "photo.png")] });
      expect(direct).toMatchObject({ completed: true, actionsCompleted: 1, totalActions: 1 });
      expect(direct.page.text).toContain("field:report.txt/5,photo.png/8");
      // A button that opens the file chooser: the chooser is answered, nothing appears on the desktop.
      const chosen = await execute({
        action: "upload",
        targetId,
        snapshot: direct.page.snapshot,
        ref: direct.page.elements.find((e) => e.name === "Choose file")!.ref,
        files: ["photo.png"],
      });
      expect(chosen).toMatchObject({ completed: true });
      expect(chosen.page.text).toContain("hidden:photo.png/8");
      expect(button).toMatch(/^e\d+$/);

      // Files outside the conversation's folder (and project folders) are refused before anything happens.
      const fresh = (await execute({ action: "inspect", targetId })) as unknown as BrowserPage;
      const again = fresh.elements.find((element) => element.name === "Attachment")!.ref;
      expect(await run({ action: "upload", targetId, ref: again, files: ["/etc/hosts"] })).toEqual({ status: "rejected", code: "upload_path_outside_roots" });
      expect(await run({ action: "upload", targetId, ref: again, files: ["../../escape.txt"] })).toMatchObject({ status: "rejected" });
      expect(await run({ action: "upload", targetId, ref: again, files: ["missing.txt"] })).toEqual({ status: "rejected", code: "upload_file_not_found" });
      expect(await run({ action: "upload", targetId, ref: again, files: ["out"] })).toEqual({ status: "rejected", code: "upload_not_a_file" });
      expect(await run({ action: "hotkey", targetId, keys: "ctrl+alt+shift+cmd+x" })).toEqual({ status: "rejected", code: "invalid_browser_input" });
    } finally {
      await driver?.close();
      chrome.kill();
      server.close();
      await rm(profile, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
