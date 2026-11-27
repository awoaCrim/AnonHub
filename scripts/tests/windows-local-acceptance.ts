import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { DeviceCapability, DeviceInvocation } from "@yesimbot/contracts";

import { conversationWorkspace } from "../../packages/device-client/src/drivers/files.js";
import { LocalDeviceTransport, LocalShellDriver, LocalFilesDriver, WindowsDesktopDriver, LocalBrowserDriver } from "../../packages/device-client/src/index.js";

// Run only as an explicitly launched interactive Windows acceptance task, in an isolated directory.
/** What the drivers return, as far as this run reads it. */
interface DesktopView {
  snapshot: string;
  windows: Array<{ title: string; handle: number }>;
  controls: Array<{ ref: string; type: string; name: string }>;
}

interface BrowserTabs {
  tabs: Array<{ id: string; url: string }>;
}

interface PageSnapshot {
  snapshot: string;
  text: string;
  elements: Array<{ ref: string; tag: string }>;
}

const root = resolve(process.argv[2]!);
const id = randomUUID(),
  tenantId = randomUUID();
const conversation = { tenantId, botId: "acceptance", platform: "test", kind: "direct" as const, conversationId: "fixture" };
const shell = new LocalShellDriver(join(root, "workspace"), true);
const desktop = new WindowsDesktopDriver(join(root, "desktop-worker.ps1"));
const browser = new LocalBrowserDriver("http://127.0.0.1:19322");
const transport = await LocalDeviceTransport.open({
  directory: join(root, "ledgers", id),
  record: {
    tenantId,
    deviceId: id,
    name: "isolated acceptance",
    platform: "win32",
    createdAt: Date.now(),
    capabilities: ["workspace.files", "computer.shell", "computer.desktop", "computer.browser"],
  },
  policy: { version: 1, direct: { enabled: true, tools: ["*"] }, group: { enabled: false, tools: [] }, actors: [] },
  drivers: [new LocalFilesDriver(join(root, "workspace")), shell, desktop, browser],
});
const invoke = async <T>(capability: DeviceCapability, method: string, input: unknown): Promise<T> => {
  const invocation: DeviceInvocation = { operationId: randomUUID(), capability, method, input, conversation, actors: [], expiresAt: Date.now() + 45000 };
  const result = await transport.invoke(id, invocation);
  if (result.status !== "succeeded") throw new Error(JSON.stringify({ capability, method, result }));
  return result.output as T;
};
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), session: process.env.SESSIONNAME };
let fixture: ReturnType<typeof spawn> | undefined, edge: ReturnType<typeof spawn> | undefined;
try {
  await invoke("workspace.files", "write", { path: "acceptance.txt", data: Buffer.from("local tools share this file").toString("base64") });
  const command = await invoke<{ stdout: string; cwd: string; durationMs: number }>("computer.shell", "exec", {
    command: "Get-Content -Raw -LiteralPath acceptance.txt",
  });
  if (!command.stdout.includes("local tools share this file")) throw new Error("workspace_shell_mismatch");
  report.shell = { ok: true, cwdMatches: command.cwd === conversationWorkspace(join(root, "workspace"), conversation), durationMs: command.durationMs };
  fixture = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-STA", "-File", join(root, "fixture.ps1")], {
    windowsHide: false,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let fixtureError = "";
  fixture.stderr?.on("data", (chunk) => {
    fixtureError += chunk.toString();
  });
  const until = Date.now() + 15000;
  let view: DesktopView | undefined, window: DesktopView["windows"][number] | undefined;
  while (Date.now() < until) {
    view = await invoke<DesktopView>("computer.desktop", "inspect", { limit: 2 });
    window = view.windows.find((w) => w.title === "YesImBot isolated acceptance");
    if (window) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!window) {
    report.nativeInspect = { windows: view?.windows, keys: Object.keys(view ?? {}), fixturePid: fixture.pid, fixtureExit: fixture.exitCode };
    throw new Error("fixture_window_missing: " + fixtureError.slice(0, 2000));
  }
  view = await invoke<DesktopView>("computer.desktop", "inspect", { window: window.handle });
  const input = view.controls.find((c) => c.type === "ControlType.Edit");
  if (!input) throw new Error("fixture_input_missing");
  await invoke("computer.desktop", "control", { snapshot: view.snapshot, ref: input.ref, action: "setValue", text: "native controls work" });
  view = await invoke<DesktopView>("computer.desktop", "inspect", { window: window.handle });
  const button = view.controls.find((c) => c.type === "ControlType.Button" && c.name === "Apply");
  if (!button) throw new Error("fixture_button_missing");
  await invoke("computer.desktop", "control", { snapshot: view.snapshot, ref: button.ref, action: "invoke" });
  view = await invoke<DesktopView>("computer.desktop", "inspect", { window: window.handle });
  if (!view.controls.some((c) => c.name === "native controls work")) throw new Error("native_result_not_observed");
  const screen = await invoke<{ width: number; height: number; data: string }>("computer.desktop", "execute", { actions: [] });
  report.desktop = {
    ok: true,
    controls: view.controls.length,
    width: screen.width,
    height: screen.height,
    screenshotBytes: Buffer.from(screen.data, "base64").length,
  };
  await mkdir(join(root, "browser-profile"), { recursive: true });
  const page = join(root, "fixture.html");
  await writeFile(
    page,
    "<!doctype html><title>YesImBot browser acceptance</title><input aria-label=\"test input\"><button onclick=\"document.querySelector('output').textContent=document.querySelector('input').value\">Apply</button><output></output>",
  );
  edge = spawn(
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    [
      "--user-data-dir=" + join(root, "browser-profile"),
      "--remote-debugging-port=19322",
      "--no-first-run",
      "--no-default-browser-check",
      pathToFileURL(page).href,
    ],
    { stdio: "ignore" },
  );
  let tabs: BrowserTabs | undefined;
  for (let i = 0; i < 40; i++) {
    try {
      tabs = await invoke<BrowserTabs>("computer.browser", "execute", { action: "tabs" });
      if (tabs.tabs.some((t) => t.url === pathToFileURL(page).href)) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const targetId = tabs?.tabs.find((t) => t.url === pathToFileURL(page).href)?.id;
  if (!targetId) throw new Error("browser_fixture_unavailable");
  let snapshot = await invoke<PageSnapshot>("computer.browser", "execute", { action: "inspect", targetId });
  const element = (tag: string) => {
    const found = snapshot.elements.find((e) => e.tag === tag);
    if (!found) throw new Error("browser_element_missing: " + tag);
    return found.ref;
  };
  await invoke("computer.browser", "execute", {
    action: "fill",
    targetId,
    snapshot: snapshot.snapshot,
    ref: element("INPUT"),
    text: "browser elements work",
  });
  snapshot = await invoke<PageSnapshot>("computer.browser", "execute", { action: "inspect", targetId });
  await invoke("computer.browser", "execute", {
    action: "click",
    targetId,
    snapshot: snapshot.snapshot,
    ref: element("BUTTON"),
  });
  snapshot = await invoke<PageSnapshot>("computer.browser", "execute", { action: "inspect", targetId });
  if (!snapshot.text.includes("browser elements work")) throw new Error("browser_result_not_observed");
  report.browser = { ok: true, elements: snapshot.elements.length };
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await transport.close();
  // Only processes created by this acceptance run, never existing user windows.
  for (const process of [fixture, edge])
    if (process?.pid) spawn("taskkill.exe", ["/pid", String(process.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  report.finishedAt = new Date().toISOString();
  await writeFile(join(root, "acceptance.json"), JSON.stringify(report, null, 2));
}
