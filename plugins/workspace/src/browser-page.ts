import { createHash } from "node:crypto";

/**
 * Body text one result shows; the device sends up to 24,000 characters. Pipeline audit, 2026-11-20: whole pages (median
 * 49 KB) went over the 24 KiB tool output budget, the element refs sat past the cut, and tasks paged through them with
 * read_tool_output (162 of 193 reads) or clicked by pixel instead.
 */
const TEXT_BYTES = 6 * 1024;
/** Element lines one result shows; the device lists up to 300 elements. */
const ELEMENT_BYTES = 14 * 1024;
/**
 * This many unnamed elements of one kind in a row share a line (`e40–e58 a ×19（无名称）`): mostly icons, which filled
 * pages like the 雨云 panel (the bot's own account, 2026-11-20). Form fields are always listed one by one.
 */
const UNNAMED_RUN = 3;
const FIELD_TAGS = new Set(["input", "textarea", "select"]);

interface DeviceElement {
  ref: string;
  tag: string;
  role: string | null;
  name: string;
  type: string | null;
  disabled: boolean;
  value?: string;
}

/** A page as the device client reports it after inspect and after each action. */
interface DevicePage {
  snapshot: string;
  targetId: string;
  loaderId?: string;
  url: string;
  title: string;
  readyState: string;
  text: string;
  elements: DeviceElement[];
  frames?: unknown[];
  settled?: boolean;
  dialogs?: unknown;
}

/**
 * The pages of one computer_browser tool as the model reads them: elements first, one line each, then a window of
 * the body text; inspect's `textOffset` and `elementOffset` read further. A page that is exactly the one this turn
 * already returned for the tab comes back as `unchanged`.
 */
export class BrowserPages {
  private readonly last = new Map<string, { turnId: string; print: string }>();

  project(input: Record<string, unknown>, output: unknown, turnId: string): unknown {
    if (isPage(output)) return this.page(output, input, turnId);
    const page = output && typeof output === "object" ? (output as { page?: unknown }).page : undefined;
    return isPage(page) ? { ...(output as object), page: this.page(page, input, turnId) } : output;
  }

  private page(page: DevicePage, input: Record<string, unknown>, turnId: string) {
    const textOffset = input.action === "inspect" ? offset(input.textOffset) : 0;
    const elementOffset = input.action === "inspect" ? offset(input.elementOffset) : 0;
    const print = `${fingerprint(page)}:${textOffset}:${elementOffset}`;
    const previous = this.last.get(page.targetId);
    this.last.set(page.targetId, { turnId, print });
    if (previous?.turnId === turnId && previous.print === print)
      return {
        snapshot: page.snapshot,
        targetId: page.targetId,
        url: page.url,
        title: page.title,
        readyState: page.readyState,
        ...(page.settled !== undefined ? { settled: page.settled } : {}),
        ...(page.dialogs ? { dialogs: page.dialogs } : {}),
        unchanged: true,
        note: "页面和上一次返回的完全一样：元素和 ref 不变，内容见上一次的结果。",
      };
    return compactPage(page, textOffset, elementOffset);
  }
}

export function compactPage(page: DevicePage, textOffset = 0, elementOffset = 0): Record<string, unknown> {
  const { elements, text, frames, loaderId: _loaderId, ...rest } = page;
  const shown = within(elementLines(elements.slice(elementOffset)), ELEMENT_BYTES);
  const lines = shown.map((entry) => entry.line);
  const elementEnd = Math.min(elements.length, elementOffset + shown.reduce((count, entry) => count + entry.count, 0));
  const body = textWindow(text, Math.min(textOffset, text.length), TEXT_BYTES);
  return {
    ...rest,
    elements: lines.join("\n"),
    ...(elementOffset > 0 || elementEnd < elements.length ? { elementRange: `${elementOffset}–${elementEnd}/${elements.length}` } : {}),
    ...(elementEnd < elements.length
      ? { moreElements: `还有 ${elements.length - elementEnd} 个元素没列出：inspect 带 elementOffset: ${elementEnd} 查看` }
      : {}),
    text: body.text,
    ...(textOffset > 0 || body.end < text.length ? { textRange: `${Math.min(textOffset, text.length)}–${body.end}/${text.length}` } : {}),
    ...(body.end < text.length ? { moreText: `正文还有 ${text.length - body.end} 字没显示：inspect 带 textOffset: ${body.end} 查看` } : {}),
    ...(frames?.length ? { frames } : {}),
  };
}

export function isPage(value: unknown): value is DevicePage {
  if (!value || typeof value !== "object") return false;
  const page = value as Partial<DevicePage>;
  return typeof page.snapshot === "string" && typeof page.targetId === "string" && typeof page.text === "string" && Array.isArray(page.elements);
}

/** One line per element, runs of unnamed ones of a kind folded into one; `count` is how many elements a line stands for. */
function elementLines(elements: readonly DeviceElement[]): { line: string; count: number }[] {
  const lines: { line: string; count: number }[] = [];
  for (let index = 0; index < elements.length;) {
    const first = elements[index]!;
    let end = index + 1;
    if (unnamed(first)) while (end < elements.length && unnamed(elements[end]!) && kindOf(elements[end]!) === kindOf(first)) end++;
    if (end - index >= UNNAMED_RUN)
      lines.push({ line: `${first.ref}–${elements[end - 1]!.ref} ${kindOf(first)} ×${end - index}（无名称）`, count: end - index });
    else for (const element of elements.slice(index, end)) lines.push({ line: elementLine(element), count: 1 });
    index = end;
  }
  return lines;
}

/** `e12 button 登录`, with its input type, role, state and value when it has them. */
function elementLine(element: DeviceElement): string {
  const name = clip(String(element.name ?? ""), 80);
  const value = element.value ? ` 值:${clip(element.value, 120)}` : "";
  return `${element.ref} ${kindOf(element)}${name ? ` ${name}` : ""}${element.disabled ? " [不可用]" : ""}${value}`;
}

function kindOf(element: DeviceElement): string {
  const tag = String(element.tag).toLowerCase();
  return `${tag}${element.type ? `[${element.type}]` : ""}${element.role && element.role !== tag ? `(${element.role})` : ""}`;
}

function unnamed(element: DeviceElement): boolean {
  return !String(element.name ?? "").trim() && !element.value && !FIELD_TAGS.has(String(element.tag).toLowerCase());
}

function clip(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

/** The leading lines that fit in `bytes`. */
function within<T extends { line: string }>(lines: readonly T[], bytes: number): T[] {
  const kept: T[] = [];
  let used = 0;
  for (const entry of lines) {
    used += Buffer.byteLength(entry.line) + 1;
    if (used > bytes) break;
    kept.push(entry);
  }
  return kept;
}

/** The text from `start` that fits in `bytes`, ending on a whole character. */
function textWindow(text: string, start: number, bytes: number): { text: string; end: number } {
  let end = start;
  let used = 0;
  while (end < text.length) {
    const point = text.codePointAt(end)!;
    const width = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (used + width > bytes) break;
    used += width;
    end += point >= 0x10000 ? 2 : 1;
  }
  return { text: text.slice(start, end), end };
}

function offset(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : 0;
}

function fingerprint(page: DevicePage): string {
  return createHash("sha256")
    .update(JSON.stringify([page.url, page.title, page.text, page.elements]))
    .digest("hex");
}
