import { EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import { expect, it, vi } from "vitest";

import { ComputerActivity } from "../../../core/src/computer-activity.js";
import { createWorkspaceComputerTools } from "../src/computer.js";

it("routes every platform to the one selected computer, never falls back on failure, and gives none without a selection", async () => {
  const invoke = vi.fn(async () => {
    throw new Error("device_offline");
  });
  const config = { deviceId: "default" };
  const granted = (name: string) => name === "computer_exec";
  const images = new EphemeralImageProjectionStore();
  for (const platform of ["onebot", "wechat-bridge", "other"]) {
    const tools = createWorkspaceComputerTools(
      { invoke, activity: new ComputerActivity() } as never,
      { platform, channelId: "same", type: "direct" } as never,
      config,
      images,
      granted,
    );
    const execution = { runtime: { id: "r" }, turnId: "t", toolCallId: "call", messages: [] } as never;
    await expect(tools[0]!.execute({ command: "pwd" } as never, execution)).rejects.toThrow("device_offline");
    expect(invoke).toHaveBeenLastCalledWith("default", expect.objectContaining({ capability: "computer.shell" }), undefined);
  }
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(
    createWorkspaceComputerTools({ invoke, activity: new ComputerActivity() } as never, { platform: "xiaoheihe" } as never, { deviceId: "" }, images, granted),
  ).toEqual([]);
});
