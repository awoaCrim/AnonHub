import type { LanguageModel } from "ai";

/** agent-desktop commands that take a screen point (`xy` "x,y", or `x` and `y`). */
const UI_POINT_TOOLS = new Set(["mouse_click", "mouse_move", "mouse_wheel"]);
const POINT: ReadonlyArray<readonly [string, Axis]> = [
  ["x", "width"],
  ["y", "height"],
];

type Axis = "width" | "height";

type Args = Record<string, unknown>;

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

export interface Prepared {
  readonly input: Args;
  /** Told to the model with the result: what was converted, or why not. */
  readonly note?: string;
}

/**
 * Screenshot sizes of one conversation's computer, by the frame their coordinates live in: the
 * whole desktop, one window, or a zoomed region of a window.
 */
export class ScreenFrames {
  private readonly sizes = new Map<string, ImageSize>();
  set(frame: string, size: ImageSize): void {
    this.sizes.set(frame, size);
  }
  get(frame: string): ImageSize | undefined {
    return this.sizes.get(frame);
  }
  clear(): void {
    this.sizes.clear();
  }
}

/**
 * Gemini models give screen points on a 0–1000 grid of the image (Google's computer-use and
 * spatial-understanding docs: "normalized 1000x1000 coordinates", pixel = value / 1000 × size),
 * whatever the tool schema says. Everything else is taken to use the screenshot's own pixels.
 */
export function usesNormalizedCoordinates(model: LanguageModel | undefined): boolean {
  const id = typeof model === "string" ? model : model?.modelId;
  return typeof id === "string" && /gemini/i.test(id);
}

/** What the model is told about a screenshot it just received. */
export function screenshotNote(size: ImageSize | undefined, normalized: boolean): string {
  const scale = normalized ? "点击坐标用 0–1000 比例（左上角 0,0，右下角 1000,1000），会自动换算成这张图的像素" : "点击坐标用这张图的像素";
  return size ? `截图 ${size.width}×${size.height} 像素；${scale}` : scale;
}

/**
 * `computer_ui` (agent-desktop) pointer input: screenshot pixels, or Gemini 0–1000 grid points, become the
 * desktop's own coordinates. A screenshot taken at a scale (a Retina Mac at 2×) is divided back down.
 */
export function prepareUi(input: Args, frames: ScreenFrames, normalized: boolean): Prepared {
  const tool = typeof input.tool === "string" ? input.tool : "";
  const args = record(input.args);
  if (tool === "sequence" && args && Array.isArray(args.actions)) {
    const notes = new Set<string>();
    const actions = args.actions.map((step) => {
      const value = record(step);
      if (!value || value.tool === "sequence") return step;
      const prepared = prepareUi(value, frames, normalized);
      if (prepared.note) notes.add(prepared.note);
      return prepared.input;
    });
    return { input: { ...input, args: { ...args, actions } }, ...(notes.size ? { note: [...notes].join("；") } : {}) };
  }
  if (!args || !UI_POINT_TOOLS.has(tool)) return { input };
  const size = frames.get("desktop");
  const scale = frames.get("scale")?.width ?? 1;
  const points: [number, number][] = [];
  const parsed = typeof args.xy === "string" ? args.xy.split(",").map((part) => Number(part.trim())) : [args.x, args.y];
  if (parsed.length !== 2 || !parsed.every((value) => typeof value === "number" && Number.isFinite(value))) return { input };
  let [x, y] = parsed as [number, number];
  let note: string | undefined;
  if (normalized) {
    if (x < 0 || x > 1000 || y < 0 || y > 1000) note = "坐标超出 0–1000，按像素处理，没有换算";
    else if (!size) return { input, note: "坐标没有换算：还没有桌面截图，先 screenshot 再点" };
    else {
      x = Math.min(size.width - 1, Math.round((x / 1000) * size.width));
      y = Math.min(size.height - 1, Math.round((y / 1000) * size.height));
      note = `坐标已按 0–1000 比例换算成截图像素：x=${x}, y=${y}`;
    }
  }
  if (scale !== 1) {
    x = Math.round(x / scale);
    y = Math.round(y / scale);
    note = `${note ? `${note}；` : ""}按屏幕缩放 ${scale}× 换算成 ${x},${y}`;
  }
  points.push([x, y]);
  const next = typeof args.xy === "string" ? { ...args, xy: `${x},${y}` } : { ...args, x, y };
  return { input: { ...input, args: next }, ...(note ? { note } : {}) };
}

/** Remembers the desktop screenshot's size and scale from a `computer_ui` result. */
export function observeUi(size: ImageSize | undefined, text: unknown, frames: ScreenFrames): void {
  if (!size) return;
  frames.set("desktop", size);
  const scale = typeof text === "string" ? Number(/"scale_factor"\s*:\s*([0-9.]+)/.exec(text)?.[1] ?? 1) : 1;
  frames.set("scale", { width: scale > 0 ? scale : 1, height: scale > 0 ? scale : 1 });
}

/** `computer_browser` click_at: Gemini grid points become pixels of that tab's latest screenshot. */
export function prepareBrowser(input: Args, frames: ScreenFrames, normalized: boolean): Prepared {
  if (!normalized || (input.action !== "click_at" && input.action !== "scroll") || typeof input.targetId !== "string") return { input };
  return convert(input, POINT, frames.get(`browser:${input.targetId}`), "这个标签页");
}

/** Remembers each tab's screenshot size from `computer_browser` screenshot and click_at results. */
export function observeBrowser(input: Args, size: ImageSize | undefined, frames: ScreenFrames): void {
  if (size && typeof input.targetId === "string") frames.set(`browser:${input.targetId}`, size);
}

/** Converts 0–1000 grid points of one tool call to pixels of the screenshot they refer to. */
function convert(args: Args, keys: ReadonlyArray<readonly [string, Axis]>, size: ImageSize | undefined, frameName: string): Prepared {
  const present = keys.filter(([key]) => args[key] !== undefined);
  if (!present.length) return { input: args };
  if (present.some(([key]) => typeof args[key] !== "number" || !Number.isFinite(args[key]) || (args[key] as number) < 0 || (args[key] as number) > 1000))
    return { input: args, note: "坐标超出 0–1000，按像素处理，没有换算" };
  if (!size) return { input: args, note: `坐标没有换算：还没有${frameName}的截图尺寸，先截图再点` };
  const next = { ...args };
  for (const [key, axis] of present) next[key] = Math.min(size[axis] - 1, Math.round(((args[key] as number) / 1000) * size[axis]));
  return { input: next, note: `坐标已按 0–1000 比例换算成截图像素：${present.map(([key]) => `${key}=${next[key]}`).join(", ")}` };
}

function record(value: unknown): Args | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Args) : undefined;
}
