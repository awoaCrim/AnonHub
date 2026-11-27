import { runInNewContext } from "node:vm";

import { expect, it, vi } from "vitest";

import { configuredCapabilities, validateClientConfig } from "../src/config.js";
import { initialClientConfig } from "../src/controller.js";
import { dashboardHtml, dashboardScript } from "../src/web-ui.js";

/** Run the shipped script, including its initial fetch and save, with an in-memory DOM and API. */
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  parent?: Element;
  checked = false;
  hidden = false;
  disabled = false;
  value = "";
  textContent = "";
  className = "";
  onclick?: () => Promise<void>;
  onchange?: () => void;
  constructor(readonly tag = "div") {}
  append(...children: Element[]) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren() {
    this.children = [];
  }
  addEventListener() {}
  closest() {
    return this.parent!;
  }
  querySelectorAll(selector: string): Element[] {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll("")]);
    return descendants.filter((element) => {
      if (selector === "button") return element.tag === "button";
      return [...selector.matchAll(/\[data-([a-z]+)(?:="([^"]*)")?\]/g)].every(
        ([, key, value]) => key! in element.dataset && (value === undefined || element.dataset[key!] === value),
      );
    });
  }
}

async function dashboard(capabilities: Record<string, unknown>, tools: string[] = ["*"]) {
  const document = new Element();
  const ids = new Map([...dashboardHtml.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id!, new Element()]));
  document.append(...ids.values());
  let saved = validateClientConfig({
    ...initialClientConfig(),
    gateway: "https://devices.example.com",
    capabilities,
    policy: { version: 1, direct: { enabled: true, tools }, group: { enabled: false, tools: [] }, actors: [] },
  });
  const fetch = vi.fn(async (path: string, options: { body?: string }) => {
    if (path === "/api/config" && options.body) saved = validateClientConfig(JSON.parse(options.body).config);
    return {
      ok: true,
      json: async () => (path === "/api/config" ? { config: structuredClone(saved), revision: "revision" } : { state: "stopped", paired: false }),
    };
  });
  const element = (id: string) => {
    const result = ids.get(id);
    if (!result) throw new Error("missing_template_element: " + id);
    return result;
  };
  runInNewContext(dashboardScript, {
    document: {
      getElementById: element,
      createElement: (tag: string) => new Element(tag),
      createTextNode: () => new Element(),
      querySelectorAll: (selector: string) => document.querySelectorAll(selector),
      querySelector: (selector: string) => document.querySelectorAll(selector)[0],
    },
    fetch,
    location: { hash: "#local-token" },
    sessionStorage: { getItem: () => null, setItem() {} },
    history: { replaceState() {} },
    structuredClone,
    setInterval: () => 0,
    clearInterval() {},
  });
  await vi.waitFor(() => expect(element("gateway").value).toBe(saved.gateway));
  return {
    element,
    method: (kind: string, method: string) => document.querySelectorAll(`[data-kind="${kind}"][data-method="${method}"]`)[0]!,
    save: async () => {
      await element("save").onclick!();
      expect(element("notice").textContent).toBe("设置已保存。");
      return saved;
    },
  };
}

it("round-trips browser, native desktop, shell directory and explicit tool grants through the local settings page", async () => {
  const capabilities = {
    files: true,
    shell: true,
    shellConversationDirectory: true,
    browser: { endpoint: "http://127.0.0.1:20422/" },
    agentDesktop: { command: "/home/anon/.local/bin/agent-desktop", physicalInput: false },
  };
  const tools = ["workspace.files.read", "computer.browser.execute", "computer.desktop.ui"];
  const page = await dashboard(capabilities, tools);
  expect(page.element("browser").checked).toBe(true);
  expect(page.element("browser-options").hidden).toBe(false);
  expect(page.element("browser-endpoint").value).toBe(capabilities.browser.endpoint);
  expect(page.element("desktop").checked).toBe(true);
  expect(page.element("desktop-options").hidden).toBe(true);
  expect(page.method("direct", "computer.browser.execute").checked).toBe(true);
  const saved = await page.save();
  expect(saved.capabilities).toMatchObject(capabilities);
  expect(saved.capabilities.desktop).toBeUndefined();
  expect(saved.policy.direct.tools).toEqual(tools);
  expect(saved.policy.group).toEqual({ enabled: false, tools: [] });
});

it("edits project directories one per line, and drops them with the files capability", async () => {
  const page = await dashboard({ files: true, projectRoots: ["/srv/app"] }, ["*"]);
  expect(page.element("files-options").hidden).toBe(false);
  expect(page.element("project-roots").value).toBe("/srv/app");
  page.element("project-roots").value = "/srv/app\n/home/me/code/a, b\n\n/srv/app\n";
  expect((await page.save()).capabilities.projectRoots).toEqual(["/srv/app", "/home/me/code/a, b"]);
  page.element("files").checked = false;
  page.element("files").onchange!();
  expect(page.element("files-options").hidden).toBe(true);
  expect((await page.save()).capabilities.projectRoots).toBeUndefined();
});

it("keeps browser off until selected and supports a browser-only grant independent of WeChat", async () => {
  const page = await dashboard({ files: true, shell: false }, []);
  expect(page.element("browser").checked).toBe(false);
  expect(page.element("browser-options").hidden).toBe(true);
  expect(page.method("direct", "computer.browser.execute").closest().hidden).toBe(true);
  expect((await page.save()).capabilities.browser).toBeUndefined();
  page.element("files").checked = false;
  page.element("browser").checked = true;
  page.element("browser").onchange!();
  expect(page.element("browser-options").hidden).toBe(false);
  expect(page.method("direct", "computer.browser.execute").closest().hidden).toBe(false);
  page.method("direct", "computer.browser.execute").checked = true;
  const saved = await page.save();
  expect(configuredCapabilities(saved)).toEqual(["computer.browser"]);
  expect(saved.capabilities.browser).toEqual({ endpoint: "http://127.0.0.1:9222/" });
  expect(saved.policy.direct.tools).toEqual(["computer.browser.execute"]);
  expect(saved.policy.group).toEqual({ enabled: false, tools: [] });
});

it("removes browser configuration and its grants when the browser capability is turned off", async () => {
  const page = await dashboard({ files: true, browser: { endpoint: "http://127.0.0.1:9222/" } }, ["workspace.files.read", "computer.browser.execute"]);
  page.element("browser").checked = false;
  page.element("browser").onchange!();
  const saved = await page.save();
  expect(saved.capabilities.browser).toBeUndefined();
  expect(saved.policy.direct.tools).toEqual(["workspace.files.read"]);
});
