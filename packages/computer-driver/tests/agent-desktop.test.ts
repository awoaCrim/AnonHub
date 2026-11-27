import { expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  calls: [] as { mode: string; name: string; arguments: unknown }[],
  answers: new Map<string, unknown[]>(),
  modes: [] as string[],
  onCall: undefined as ((tool: string) => void) | undefined,
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    readonly mode: string;
    constructor(options: { args: string[] }) {
      this.mode = options.args.includes("--headed") ? "physical" : "quiet";
      mock.modes.push(this.mode);
    }
    close = vi.fn();
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    mode = "";
    async connect(transport: { mode: string }) {
      this.mode = transport.mode;
    }
    async callTool(request: { name: string; arguments: unknown }) {
      mock.calls.push({ mode: this.mode, ...request });
      mock.onCall?.(request.name);
      const queue = mock.answers.get(`${this.mode}:${request.name}`) ?? mock.answers.get(request.name) ?? [];
      return queue.length > 1 ? queue.shift() : queue[0];
    }
    async listTools() {
      return { tools: [{ name: "desktop_click" }, { name: "desktop_session_start" }] };
    }
    close = vi.fn(async () => {});
  },
}));
import { AgentDesktopClient, desktopSequenceProblem, refusedQuietly } from "../src/agent-desktop.js";

const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const shot = {
  content: [
    { type: "text", text: JSON.stringify({ ok: true }) },
    { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
  ],
};
const signal = new AbortController().signal;

it("acts quietly first, answers with a fresh screenshot, and refuses commands outside the list", async () => {
  mock.calls.length = 0;
  mock.answers.clear();
  mock.answers.set("desktop_click", [text({ ok: true, command: "click" })]);
  mock.answers.set("desktop_screenshot", [shot]);
  const client = new AgentDesktopClient("/opt/agent-desktop/agent-desktop");
  const result = await client.call("click", { ref_id: "@s1:e2" }, signal);
  expect(result).toMatchObject({ isError: false, data: "aGVsbG8=", mediaType: "image/png" });
  expect(mock.calls.map((c) => `${c.mode}:${c.name}`)).toEqual(["quiet:desktop_click", "quiet:desktop_screenshot"]);
  await expect(client.call("session_start", {}, signal)).rejects.toThrow("unsupported_desktop_tool");
  // Snapshots default to the interactive, collapsed tree; describe lists only allowed commands.
  mock.answers.set("desktop_snapshot", [text({ ok: true })]);
  await client.call("snapshot", { app: "chromium" }, signal);
  expect(mock.calls.at(-1)).toMatchObject({ name: "desktop_snapshot", arguments: { app: "chromium", interactive_only: true, compact: true } });
  expect(JSON.parse((await client.call("describe", {}, signal)).text)).toEqual([{ name: "click" }]);
  await client.close();
});

it("repeats a refused quiet attempt once with real input, unless real input is off", async () => {
  mock.calls.length = 0;
  mock.answers.clear();
  mock.answers.set("quiet:desktop_type", [text({ ok: false, error: { code: "POLICY_DENIED", disposition: { delivery: "not_delivered", retry: "safe" } } })]);
  mock.answers.set("physical:desktop_type", [text({ ok: true, command: "type" })]);
  mock.answers.set("desktop_screenshot", [shot]);
  const client = new AgentDesktopClient("/x/agent-desktop");
  expect(await client.call("type", { ref_id: "@s1:e3", text: "你好" }, signal)).toMatchObject({ isError: false, physical: true, data: "aGVsbG8=" });
  expect(mock.calls.map((c) => `${c.mode}:${c.name}`)).toEqual(["quiet:desktop_type", "physical:desktop_type", "quiet:desktop_screenshot"]);
  await client.close();
  mock.calls.length = 0;
  const careful = new AgentDesktopClient("/x/agent-desktop", { physicalInput: false });
  expect(await careful.call("type", { ref_id: "@s1:e3", text: "x" }, signal)).toMatchObject({ isError: true });
  expect(mock.calls.map((c) => c.mode)).toEqual(["quiet"]);
  await careful.close();
});

it("treats only safe, undelivered refusals as worth a real-input retry", () => {
  expect(refusedQuietly(JSON.stringify({ ok: false, error: { code: "TIMEOUT", disposition: { delivery: "not_delivered", retry: "safe" } } }))).toBe(true);
  expect(refusedQuietly(JSON.stringify({ ok: false, error: { code: "INVALID_ARGS", disposition: { delivery: "not_delivered", retry: "safe" } } }))).toBe(false);
  expect(
    refusedQuietly(JSON.stringify({ ok: false, error: { code: "ACTION_FAILED", disposition: { delivery: "delivered_unverified", retry: "unsafe" } } })),
  ).toBe(false);
  expect(refusedQuietly("not json")).toBe(false);
});

it("runs a desktop sequence in one operation, with one final screenshot and scale metadata", async () => {
  mock.calls.length = 0;
  mock.answers.clear();
  for (const tool of ["clipboard_set", "press"]) mock.answers.set(`desktop_${tool}`, [text({ ok: true })]);
  mock.answers.set("desktop_screenshot", [{ content: [...shot.content.slice(1), ...text({ ok: true, scale_factor: 2 }).content] }]);
  const client = new AgentDesktopClient("/x/agent-desktop");
  try {
    const result = await client.call(
      "sequence",
      {
        actions: [
          { tool: "clipboard_set", args: { text: "hello" } },
          { tool: "press", args: { combo: "ctrl+v" } },
          { tool: "press", args: { combo: "return" } },
        ],
      },
      signal,
    );
    expect(result).toMatchObject({ isError: false, data: "aGVsbG8=" });
    expect(JSON.parse(result.text.split("\n")[0]!)).toMatchObject({ ok: true, completed: 3, total: 3 });
    expect(result.text).toContain('"scale_factor":2');
    expect(mock.calls.map((c) => c.name)).toEqual(["desktop_clipboard_set", "desktop_press", "desktop_press", "desktop_screenshot"]);
  } finally {
    await client.close();
  }
});

it("stops after the first failed action and returns the current screen without running later steps", async () => {
  mock.calls.length = 0;
  mock.answers.clear();
  mock.answers.set("desktop_clipboard_set", [text({ ok: true })]);
  mock.answers.set("desktop_press", [text({ ok: false, error: { code: "STALE_REF" } })]);
  mock.answers.set("desktop_screenshot", [shot]);
  const client = new AgentDesktopClient("/x/agent-desktop");
  try {
    const result = await client.call(
      "sequence",
      {
        actions: [
          { tool: "clipboard_set", args: { text: "hello" } },
          { tool: "press", args: { combo: "ctrl+v" } },
          { tool: "press", args: { combo: "return" } },
        ],
      },
      signal,
    );
    expect(result).toMatchObject({ isError: true, data: "aGVsbG8=" });
    expect(JSON.parse(result.text.split("\n")[0]!)).toMatchObject({ completed: 1, failedAt: 1, total: 3 });
    expect(mock.calls.map((c) => c.name)).toEqual(["desktop_clipboard_set", "desktop_press", "desktop_screenshot"]);
  } finally {
    await client.close();
  }
});

it("validates the whole sequence before effects and honors cancellation between actions", async () => {
  mock.calls.length = 0;
  mock.answers.clear();
  mock.answers.set("desktop_clipboard_set", [text({ ok: true })]);
  const client = new AgentDesktopClient("/x/agent-desktop");
  const controller = new AbortController();
  try {
    for (const actions of [
      [],
      Array.from({ length: 9 }, () => ({ tool: "press" })),
      [{ tool: "press" }, { tool: "sequence" }],
      [{ tool: "wait", args: { ms: 50000 } }],
    ])
      await expect(client.call("sequence", { actions }, signal)).rejects.toThrow("invalid_desktop_sequence");
    expect(mock.calls).toHaveLength(0);
    mock.onCall = (tool) => {
      if (tool === "desktop_clipboard_set") controller.abort();
    };
    await expect(
      client.call(
        "sequence",
        {
          actions: [
            { tool: "clipboard_set", args: { text: "hello" } },
            { tool: "press", args: { combo: "ctrl+v" } },
          ],
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(mock.calls.map((c) => c.name)).toEqual(["desktop_clipboard_set"]);
  } finally {
    mock.onCall = undefined;
    await client.close();
  }
});

it("names what is wrong with a malformed sequence so the model can correct it", () => {
  expect(
    desktopSequenceProblem({
      actions: [
        { tool: "press", args: { combo: "ctrl+l" } },
        { tool: "wait", args: { ms: 500 } },
      ],
    }),
  ).toBeUndefined();
  expect(desktopSequenceProblem({ actions: [{ action: "press", key: "ctrl+l" }] })).toContain("第 1 步只能有 tool 和 args");
  expect(desktopSequenceProblem({ actions: [{ tool: "press" }, { tool: "wait", args: { duration_ms: 1000 } }] })).toContain("第 2 步的 wait 要写 args.ms");
  expect(desktopSequenceProblem({ actions: [{ tool: "sequence" }] })).toContain("不是可用动作");
  expect(desktopSequenceProblem({ actions: [] })).toContain("非空数组");
  expect(desktopSequenceProblem({ actions: [{ tool: "press" }], wait: 1 })).toContain("只能有 actions");
});
