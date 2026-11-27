import type { ComputerAction, ComputerDriver, ComputerScreenshot } from "@yesimbot/computer-driver";
import { tool, type ToolSet } from "ai";
import { z } from "zod/v4";

export const CONFIRMATION_TOOL = "request_confirmation";

const MAX_TEXT_LENGTH = 4_000;
const MAX_KEYS = 12;
const MAX_KEY_LENGTH = 32;
const MAX_DRAG_POINTS = 128;
const MAX_COORDINATE = 16_383;
const MAX_SCROLL = 1_000_000;

const coordinate = z.number().min(0).max(MAX_COORDINATE);
const keyName = z.string().min(1).max(MAX_KEY_LENGTH);
const modifiers = z.array(keyName).max(MAX_KEYS).optional().describe('Modifier keys held during the action, e.g. ["CTRL"].');

export interface DesktopToolsOptions {
  readonly driver: ComputerDriver;
  readonly signal: AbortSignal;
  readonly displayWidth: number;
  readonly displayHeight: number;
  /** Called with every screenshot the desktop returns, so the caller always holds the latest one. */
  readonly onScreenshot: (screenshot: ComputerScreenshot) => void;
  /** A driver failure ends the loop; the AI SDK would otherwise hand it to the model as a tool error. */
  readonly onFailure: (cause: unknown) => void;
}

/** The desktop_* function tools. Each result carries the screenshot after the action back to the model. */
export function createDesktopTools(options: DesktopToolsOptions): ToolSet {
  const { displayWidth: width, displayHeight: height } = options;
  const coordinateNote = `Screen coordinates are in screenshot pixels: x is 0-${width - 1}, y is 0-${height - 1}.`;
  // Parallel calls of one step share one desktop; their actions run in the order the model gave them.
  let queue: Promise<unknown> = Promise.resolve();
  const screenshots = new Map<string, ComputerScreenshot>();

  const desktopTool = <S extends z.ZodType>(
    description: string,
    inputSchema: S,
    action: (input: z.infer<S>) => ComputerAction,
    describe: (input: z.infer<S>) => string,
  ) =>
    tool({
      description,
      inputSchema,
      execute: (input: z.infer<S>, { toolCallId }) => {
        const run = queue.then(async () => {
          try {
            const screenshot = await options.driver.execute([action(input)], options.signal);
            options.onScreenshot(screenshot);
            screenshots.set(toolCallId, screenshot);
            return `ok: ${describe(input)}`;
          } catch (cause) {
            options.onFailure(cause);
            throw cause;
          }
        });
        queue = run.catch(() => undefined);
        return run;
      },
      toModelOutput: ({ toolCallId, output }) => {
        const screenshot = screenshots.get(toolCallId);
        screenshots.delete(toolCallId);
        return {
          type: "content",
          value: [
            { type: "text", text: output },
            ...(screenshot ? [{ type: "image-data" as const, data: Buffer.from(screenshot.bytes).toString("base64"), mediaType: screenshot.mediaType }] : []),
          ],
        };
      },
    });

  const keysOf = (keys: readonly string[] | undefined) => (keys && keys.length > 0 ? { keys } : {});
  const at = (x: number, y: number) => ({ x: Math.round(x), y: Math.round(y) });

  return {
    desktop_move: desktopTool(
      `Move the mouse pointer. ${coordinateNote}`,
      z.strictObject({ x: coordinate, y: coordinate, keys: modifiers }),
      ({ x, y, keys }) => ({ type: "move", ...at(x, y), ...keysOf(keys) }),
      ({ x, y }) => `desktop_move (${Math.round(x)}, ${Math.round(y)})`,
    ),
    desktop_click: desktopTool(
      `Click once at a screen position. ${coordinateNote}`,
      z.strictObject({ x: coordinate, y: coordinate, button: z.enum(["left", "right", "wheel", "back", "forward"]).optional(), keys: modifiers }),
      ({ x, y, button, keys }) => ({ type: "click", button: button ?? "left", ...at(x, y), ...keysOf(keys) }),
      ({ x, y, button }) => `desktop_click ${button ?? "left"} at (${Math.round(x)}, ${Math.round(y)})`,
    ),
    desktop_double_click: desktopTool(
      `Double click at a screen position. ${coordinateNote}`,
      z.strictObject({ x: coordinate, y: coordinate, keys: modifiers }),
      ({ x, y, keys }) => ({ type: "double_click", ...at(x, y), ...keysOf(keys) }),
      ({ x, y }) => `desktop_double_click at (${Math.round(x)}, ${Math.round(y)})`,
    ),
    desktop_drag: desktopTool(
      `Drag along an ordered list of points. ${coordinateNote}`,
      z.strictObject({
        path: z
          .array(z.strictObject({ x: coordinate, y: coordinate }))
          .min(2)
          .max(MAX_DRAG_POINTS),
        keys: modifiers,
      }),
      ({ path, keys }) => ({ type: "drag", path: path.map((point) => at(point.x, point.y)), ...keysOf(keys) }),
      ({ path }) => `desktop_drag through ${path.length} points`,
    ),
    desktop_type: desktopTool(
      "Type text into the currently focused input. Use desktop_click first to focus the right field.",
      z.strictObject({ text: z.string().min(1).max(MAX_TEXT_LENGTH) }),
      ({ text }) => ({ type: "type", text }),
      ({ text }) => `desktop_type ${text.length} characters`,
    ),
    desktop_key: desktopTool(
      'Press one key combination, e.g. ["CTRL","L"] or ["Return"].',
      z.strictObject({ keys: z.array(keyName).min(1).max(MAX_KEYS) }),
      ({ keys }) => ({ type: "keypress", keys }),
      ({ keys }) => `desktop_key ${keys.join("+")}`,
    ),
    desktop_scroll: desktopTool(
      `Scroll at a screen position. ${coordinateNote}`,
      z.strictObject({
        x: coordinate,
        y: coordinate,
        scrollX: z.number().min(-MAX_SCROLL).max(MAX_SCROLL),
        scrollY: z.number().min(-MAX_SCROLL).max(MAX_SCROLL),
        keys: modifiers,
      }),
      ({ x, y, scrollX, scrollY, keys }) => ({ type: "scroll", ...at(x, y), scrollX, scrollY, ...keysOf(keys) }),
      ({ x, y, scrollX, scrollY }) => `desktop_scroll (${scrollX}, ${scrollY}) at (${Math.round(x)}, ${Math.round(y)})`,
    ),
    desktop_screenshot: desktopTool(
      "Take a fresh screenshot without changing anything. A screenshot is already attached after every action.",
      z.strictObject({}),
      () => ({ type: "screenshot" }),
      () => "screenshot captured",
    ),
    desktop_wait: desktopTool(
      "Wait about a second for the desktop to settle, e.g. after launching an application.",
      z.strictObject({ seconds: z.number().min(0.25).max(5).optional().describe("Requested pause; the executor waits a fixed short interval.") }),
      () => ({ type: "wait" }),
      () => "waited",
    ),
    // No `execute`: the loop ends at this call, and the middleware in loop.ts drops every other call of the step.
    [CONFIRMATION_TOOL]: tool({
      description:
        "Ask the user for confirmation before a consequential action: purchases, payments, account or credential changes, deleting important data, or sending messages to other people. Calling this executes nothing.",
      inputSchema: z.strictObject({ reason: z.string().max(512) }),
    }),
  };
}
