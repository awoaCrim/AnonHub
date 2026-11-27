import { afterEach, expect, it, vi } from "vitest";

import { ComputerActivity } from "../src/computer-activity.js";

afterEach(() => vi.unstubAllEnvs());
it("tracks running, success, exceptions and failed device/shell results without retaining outputs", async () => {
  const activity = new ComputerActivity();
  let finish!: (value: unknown) => void;
  const pending = activity.record(
    "computer_exec",
    { command: "pwd" },
    "device",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  expect(activity.list()[0]).toMatchObject({ tool: "computer_exec", label: "命令行", summary: "pwd", status: "running", deviceId: "device" });
  finish({ status: "succeeded", output: { exitCode: 0, stdout: "private-result" } });
  await pending;
  expect(activity.list()[0].status).toBe("ok");
  for (const result of [
    { status: "failed" },
    { status: "unknown" },
    { status: "rejected" },
    { status: "succeeded", output: { exitCode: 1 } },
    { isError: true },
    { success: false },
  ]) {
    await activity.record("computer_use", { actions: [{ type: "click" }] }, "device", () => result);
    expect(activity.list()[0].status).toBe("failed");
  }
  await expect(
    activity.record("computer_browser", { action: "tabs" }, "device", () => {
      throw new Error("secret");
    }),
  ).rejects.toThrow();
  expect(activity.list()[0].status).toBe("failed");
  expect(JSON.stringify(activity.list())).not.toMatch(/private-result|secret|stdout/);
});
it("bounds the ring at 200, orders newest first, filters before limit, and returns detached snapshots", async () => {
  const activity = new ComputerActivity();
  for (let i = 0; i < 210; i++) await activity.record("computer_exec", { command: `echo ${i}` }, i % 2 ? "odd" : "even", () => ({}));
  expect(activity.list(undefined, 100)).toHaveLength(100);
  expect(activity.list("even", 100)).toHaveLength(100);
  expect(activity.list("even", 100).at(-1)?.summary).toBe("echo 10");
  expect(activity.list()[0].summary).toBe("echo 209");
  activity.list()[0].summary = "mutated";
  expect(activity.list()[0].summary).toBe("echo 209");
  expect(new ComputerActivity().list()).toEqual([]);
});
it("redacts environment values, assignments, auth flags, URL secrets, API keys and binary payloads before truncation", async () => {
  vi.stubEnv("ACTIVITY_TEST_PRIVATE", "env-private-value");
  const activity = new ComputerActivity();
  const command =
    'TOKEN=assignment-private curl -H "Authorization: Bearer header-private" https://user:password@example.test/page?key=url-private#fragment env-private-value sk-api-private ghp_githubprivate data:image/png;base64,aW1hZ2U=';
  await activity.record("computer_exec", { command, env: { OTHER: "ignored" }, apiKey: "ignored" }, "device", () => ({}));
  const summary = activity.list()[0].summary;
  expect(summary).toContain("[redacted]");
  expect(summary).not.toMatch(/assignment-private|header-private|password|url-private|fragment|env-private-value|api-private|githubprivate|aW1hZ2U|ignored/);
  await activity.record("computer_exec", { command: "echo " + "word ".repeat(100) }, "device", () => ({}));
  expect(activity.list()[0].summary).toHaveLength(200);
  await activity.record("computer_browser", { action: "navigate", url: "https://user:password@example.test/page?key=secret#token" }, "device", () => ({}));
  expect(activity.list()[0].summary).toBe("navigate https://example.test/page?[redacted]");
});
it("covers all computer tools using only action names, never typed strings, arbitrary fields or screenshots", async () => {
  const activity = new ComputerActivity();
  for (const tool of ["computer_use", "computer_ui", "computer_browser"] as const) {
    await activity.record(
      tool,
      { actions: [{ type: "click" }, { type: "type", text: "private-password" }, { type: "scroll" }], screenshot: "private-base64" },
      "device",
      () => ({}),
    );
    expect(activity.list()[0]).toMatchObject({ tool, summary: "click, type, scroll", status: "ok" });
  }
  await activity.record("computer_ui", { tool: "type_text", args: { text: "private-password" } }, "device", () => ({}));
  expect(activity.list()[0].summary).toBe("type_text");
  await activity.record(
    "computer_ui",
    { tool: "sequence", args: { actions: [{ tool: "clipboard_set", args: { text: "private-password" } }, { tool: "press" }] } },
    "device",
    () => ({}),
  );
  expect(activity.list()[0].summary).toBe("clipboard_set, press");
  await activity.record(
    "computer_browser",
    {
      action: "sequence",
      actions: [
        { action: "fill", ref: "e0", text: "private-password" },
        { action: "press", key: "Enter" },
      ],
    },
    "device",
    () => ({}),
  );
  expect(activity.list()[0].summary).toBe("fill, press");
  expect(JSON.stringify(activity.list())).not.toContain("private-");
});
it("strips credentials from every URL scheme, not only http(s)", async () => {
  const activity = new ComputerActivity();
  for (const command of [
    "psql postgres://admin:pg-private@db.example.test/prod",
    "mongosh mongodb+srv://user:mongo-private@cluster.example.test/db?replicaSet=query-private",
    "git clone git+ssh://git:ssh-private@example.test/org/repo.git",
    "curl ftp://anon:ftp-private@ftp.example.test/file",
  ])
    await activity.record("computer_exec", { command }, "device", () => ({}));
  const summaries = activity.list().map((item) => item.summary);
  expect(summaries).toContain("psql postgres://db.example.test/prod");
  expect(summaries.join("\n")).not.toMatch(/private|admin:|user:|anon:/);
});
it("summarizes 64 KiB single-token commands in linear time before the tool runs", async () => {
  const activity = new ComputerActivity();
  for (const command of ["echo " + "a1".repeat(32_000) + " | xxd -r -p > out.bin", "-".repeat(65_000), "-" + "a".repeat(65_000)]) {
    const started = performance.now();
    await activity.record("computer_exec", { command }, "device", () => ({}));
    // Quadratic patterns took 2-8 s here and blocked the whole runtime's event loop.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(activity.list()[0].summary.length).toBeLessThanOrEqual(200);
  }
});
it("never lets summarizing or status classification change the tool's result or error", async () => {
  const activity = new ComputerActivity();
  const input = Object.defineProperty({}, "command", {
    get() {
      throw new Error("unreadable input");
    },
  });
  const execute = vi.fn(() => ({ status: "succeeded", output: { exitCode: 0 } }));
  await expect(activity.record("computer_exec", input, "device", execute)).resolves.toEqual({ status: "succeeded", output: { exitCode: 0 } });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(activity.list()[0]).toMatchObject({ summary: "", status: "ok" });
  const cyclic: Record<string, unknown> = { status: "succeeded" };
  cyclic.output = cyclic;
  await expect(activity.record("computer_use", { actions: [] }, "device", () => cyclic)).resolves.toBe(cyclic);
  const error = new Error("tool failure");
  await expect(
    activity.record("computer_exec", { command: "pwd" }, "device", () => {
      throw error;
    }),
  ).rejects.toBe(error);
});

// User, 2026-11-18: the web chat shows its own computer work as it happens.
it("records which conversation and turn an operation came from, and tells listeners when it starts and ends", async () => {
  const activity = new ComputerActivity();
  const seen: string[] = [];
  const stop = activity.subscribe((item) => {
    seen.push(`${item.status}:${item.origin?.channelId}:${item.origin?.turnId}`);
    // A listener holds a copy: changing it never alters the list.
    item.summary = "changed";
  });
  activity.subscribe(() => {
    throw Error("a broken listener never affects the tool");
  });
  await activity.record("computer_browser", { action: "navigate", url: "https://example.com/a" }, "device", () => ({ ok: true }), {
    platform: "web",
    channelId: "owner",
    turnId: "turn-1",
  });
  expect(seen).toEqual(["running:owner:turn-1", "ok:owner:turn-1"]);
  expect(activity.list()[0]).toMatchObject({ origin: { platform: "web", channelId: "owner", turnId: "turn-1" } });
  expect(activity.list()[0].summary).not.toBe("changed");
  stop();
  await activity.record("computer_exec", { command: "pwd" }, "device", () => ({ status: "succeeded" }));
  expect(seen).toHaveLength(2);
  expect(activity.list()[0].origin).toBeUndefined();
});
