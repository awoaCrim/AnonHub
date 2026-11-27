import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { AgentDesktopDriver, bundledAgentDesktop } from "../src/drivers/agent-desktop.js";

it("finds the agent-desktop shipped beside the client and makes it runnable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-desktop-bundle-"));
  try {
    expect(bundledAgentDesktop(directory)).toBeUndefined();
    if (process.platform !== "linux") return;
    const binary = join(directory, `agent-desktop-linux-${process.arch}`);
    await writeFile(binary, "#!/bin/sh\n");
    await chmod(binary, 0o600);
    expect(bundledAgentDesktop(directory)?.command).toBe(binary);
    expect((await stat(binary)).mode & 0o111).not.toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps the client running when agent-desktop is missing: desktop control is unhealthy and refuses", async () => {
  const driver = new AgentDesktopDriver({ command: "relative/agent-desktop" });
  expect(driver.healthy()).toBe(false);
  const result = await driver.methods.ui!.execute({ input: { tool: "snapshot", args: {} } } as never, new AbortController().signal);
  expect(result).toEqual({ status: "rejected", code: "agent_desktop_not_found" });
  await driver.close();
});

it("refuses a malformed sequence before agent-desktop runs, so the bot can correct it", async () => {
  // A computer_browser-style step and a wait without `ms`, as a model actually sent them.
  const actions = [
    { action: "press", key: "ctrl+l" },
    { tool: "wait", args: { duration_ms: 1000 } },
  ];
  const driver = new AgentDesktopDriver({ command: "/nonexistent/agent-desktop" });
  const result = await driver.methods.ui!.execute({ input: { tool: "sequence", args: { actions } } } as never, new AbortController().signal);
  expect(result).toEqual({ status: "rejected", code: "invalid_desktop_input" });
  await driver.close();
});
