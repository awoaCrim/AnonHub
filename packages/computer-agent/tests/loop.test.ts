import type { ComputerDriver, ComputerScreenshot } from "@yesimbot/computer-driver";
import { describe, expect, it, vi } from "vitest";

import { runComputerUse } from "../src/loop.js";
import { scriptedModel, type ScriptedStep } from "./scripted-model.js";

const SCREENSHOT: ComputerScreenshot = { bytes: new Uint8Array([137, 80, 78, 71, 1]), mediaType: "image/png" };

function driver() {
  const execute = vi.fn(async () => SCREENSHOT);
  return { driver: { execute, close: vi.fn(async () => undefined) } satisfies ComputerDriver, execute };
}

function run(steps: ScriptedStep[] | ((index: number) => ScriptedStep), signal = new AbortController().signal) {
  const bound = driver();
  const script = scriptedModel(steps);
  const done = runComputerUse({ prompt: "任务", model: script.model, driver: bound.driver, signal, displayWidth: 1280, displayHeight: 800 });
  return { ...bound, ...script, done };
}

const images = (prompt: unknown) => JSON.stringify(prompt).match(/"type":"(file|image-data)"/g)?.length ?? 0;

describe("runComputerUse", () => {
  it("captures a starting screenshot, runs actions and returns the verified summary", async () => {
    const t = run([[{ name: "desktop_click", args: { x: 12.4, y: 30 } }], "打开并确认了页面。"]);
    const result = await t.done;

    expect(t.execute).toHaveBeenNthCalledWith(1, [], expect.any(AbortSignal));
    expect(t.execute).toHaveBeenNthCalledWith(2, [{ type: "click", button: "left", x: 12, y: 30 }], expect.any(AbortSignal));
    expect(result.result).toMatchObject({ ok: true, status: "completed", summary: "打开并确认了页面。", steps: 2 });
    expect(result.screenshot).toBe(SCREENSHOT);
    expect(JSON.stringify(t.prompts[0])).toContain("任务");
    expect(images(t.prompts[0])).toBe(1);
  });

  it("returns the screenshot after each action to the model with the tool result", async () => {
    const t = run([[{ name: "desktop_screenshot" }], "完成"]);
    await t.done;

    const tool = t.prompts[1]!.find((message) => message.role === "tool")!;
    expect(JSON.stringify(tool)).toContain("ok: screenshot captured");
    expect(JSON.stringify(tool)).toContain("image/png");
  });

  it("stops without executing anything when the model asks for confirmation", async () => {
    const t = run([
      [
        { name: "desktop_click", args: { x: 1, y: 1 }, id: "call-1" },
        { name: "request_confirmation", args: { reason: "支付 2399 元" }, id: "call-2" },
      ],
    ]);
    const result = await t.done;

    expect(t.execute).toHaveBeenCalledTimes(1);
    expect(result.result).toMatchObject({
      ok: false,
      error: { code: "safety_check_required" },
      safetyChecks: [{ id: "call-2", code: "confirmation_requested", message: "支付 2399 元" }],
    });
  });

  it("refuses a step with too many actions", async () => {
    const t = run([Array.from({ length: 9 }, () => ({ name: "desktop_wait" }))]);

    expect((await t.done).result).toMatchObject({ ok: false, error: { code: "invalid_response" } });
    expect(t.execute).toHaveBeenCalledTimes(1);
  });

  it("lets the model correct an invalid call without touching the desktop", async () => {
    const t = run([[{ name: "desktop_click", args: { x: -5, y: 10 } }], "放弃"]);
    const result = await t.done;

    expect(t.execute).toHaveBeenCalledTimes(1);
    expect(result.result).toMatchObject({ ok: true, steps: 2 });
  });

  it("runs the parallel calls of one step in order", async () => {
    const order: string[] = [];
    const bound = driver();
    bound.execute.mockImplementation(async (actions: readonly { type: string }[]) => {
      const type = actions[0]?.type ?? "start";
      order.push(`${type}:start`);
      await new Promise((resolve) => setTimeout(resolve, type === "wait" ? 10 : 0));
      order.push(`${type}:end`);
      return SCREENSHOT;
    });
    const script = scriptedModel([[{ name: "desktop_wait" }, { name: "desktop_screenshot" }], "好"]);
    await runComputerUse({
      prompt: "p",
      model: script.model,
      driver: bound.driver,
      signal: new AbortController().signal,
      displayWidth: 1280,
      displayHeight: 800,
    });

    expect(order.slice(2)).toEqual(["wait:start", "wait:end", "screenshot:start", "screenshot:end"]);
  });

  it("surfaces a driver failure instead of showing it to the model", async () => {
    const bound = driver();
    bound.execute.mockResolvedValueOnce(SCREENSHOT).mockRejectedValueOnce(new Error("桌面没有活动会话"));
    const script = scriptedModel([[{ name: "desktop_wait" }], "好"]);

    await expect(
      runComputerUse({ prompt: "p", model: script.model, driver: bound.driver, signal: new AbortController().signal, displayWidth: 1280, displayHeight: 800 }),
    ).rejects.toThrow("桌面没有活动会话");
    expect(script.prompts).toHaveLength(1);
  });

  it("continues beyond fifty steps until the model finishes", async () => {
    const t = run((index) => (index < 64 ? [{ name: "desktop_wait" }] : "完成并确认了任务。"));
    const result = await t.done;

    expect(t.execute).toHaveBeenCalledTimes(65);
    expect(result.result).toMatchObject({ ok: true, status: "completed", summary: "完成并确认了任务。", steps: 65 });
  });

  it("honors cancellation between steps", async () => {
    const controller = new AbortController();
    const bound = driver();
    bound.execute.mockImplementation(async () => {
      if (bound.execute.mock.calls.length === 4) controller.abort();
      return SCREENSHOT;
    });
    const script = scriptedModel(() => [{ name: "desktop_wait" }]);

    await expect(
      runComputerUse({ prompt: "p", model: script.model, driver: bound.driver, signal: controller.signal, displayWidth: 1280, displayHeight: 800 }),
    ).rejects.toThrow();
    expect(script.prompts.length).toBeLessThan(10);
  });

  it("keeps the request bounded and only the latest screenshot in it", async () => {
    const t = run((index) => (index < 8 ? [{ name: "desktop_screenshot" }] : "完成"));
    await t.done;

    const last = t.prompts[8]!;
    // The task message plus four steps of an assistant message and its tool result.
    expect(last.filter((message) => message.role !== "system")).toHaveLength(9);
    expect(images(last)).toBe(1);
    expect(JSON.stringify(last)).toContain("Earlier screenshots were omitted");
  });
});
