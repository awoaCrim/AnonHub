import { z } from "zod/v4";

/** The input of the sandbox and device `editFile` tools: one definition, one set of limits. */
export const EDIT_FILE_SCHEMA = z.strictObject({
  path: z.string().max(4096),
  oldString: z
    .string()
    .min(1)
    .max(128 * 1024),
  newString: z.string().max(128 * 1024),
  replaceAll: z.boolean().optional(),
});

/** A diff stops growing past this many characters; the edit itself is never shortened. */
const DIFF_CHARS = 6000;

/** Why an exact edit was refused; each tool words the reason in its own result envelope. */
export type ExactEditRefusal = "empty_old_string" | "no_change" | "not_found" | "ambiguous";

/** Where one replacement went, as character offsets in the text before and after the edit. */
export type EditSpan = { oldStart: number; oldEnd: number; newStart: number; newEnd: number };

export type ExactEditResult = { ok: true; text: string; replacements: number; spans: EditSpan[] } | { ok: false; code: ExactEditRefusal; occurrences?: number };

/**
 * One exact-text edit, shared by the sandbox and device `editFile` tools so their rules cannot drift apart.
 * `newString` is inserted literally: `String#replace` would expand `$&`, `$'`, `` $` `` and `$$` in it, which
 * silently corrupts shell scripts (`IFS=$'\n'`) and Compose files (`$$HOME`).
 *
 * A file with CRLF line endings also matches an `oldString` written with plain `\n` (models copy lines without
 * the `\r`); the replacement then gets CRLF endings too.
 */
export function applyExactEdit(text: string, oldString: string, newString: string, replaceAll = false): ExactEditResult {
  if (!oldString) return { ok: false, code: "empty_old_string" };
  if (oldString === newString) return { ok: false, code: "no_change" };
  if (!text.includes(oldString) && text.includes("\r\n") && oldString.includes("\n") && !oldString.includes("\r\n")) {
    const crlf = (value: string) => value.replace(/\r?\n/g, "\r\n");
    return applyExactEdit(text, crlf(oldString), crlf(newString), replaceAll);
  }
  const spans: EditSpan[] = [];
  let shift = 0;
  for (let index = text.indexOf(oldString); index !== -1; index = text.indexOf(oldString, index + oldString.length)) {
    spans.push({ oldStart: index, oldEnd: index + oldString.length, newStart: index + shift, newEnd: index + shift + newString.length });
    shift += newString.length - oldString.length;
  }
  if (!spans.length) return { ok: false, code: "not_found" };
  if (spans.length > 1 && !replaceAll) return { ok: false, code: "ambiguous", occurrences: spans.length };
  return { ok: true, text: text.split(oldString).join(newString), replacements: spans.length, spans };
}

/** Whether an `oldString` that matched nothing seems to carry the line-number prefixes `readFile` displays. */
export function hasLineNumberPrefix(oldString: string): boolean {
  return /^\s*\d+\t/.test(oldString);
}

/**
 * A unified diff of an exact edit, with `context` unchanged lines around each change. Built from the edit's spans:
 * the text outside them is identical, so no general diff is needed.
 */
export function editDiff(path: string, before: string, after: string, spans: readonly EditSpan[], context = 3): string {
  const starts = lineStarts(before);
  const lineOf = (index: number) => {
    let low = 0,
      high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= index) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const lineEnd = (line: number) => (line + 1 < starts.length ? starts[line + 1]! : before.length);
  const oldLines = splitLines(before);

  // Whole changed lines per span; spans sharing a line form one block.
  type Block = { first: number; last: number; shiftBefore: number; shiftAfter: number };
  const blocks: Block[] = [];
  let shift = 0;
  for (const span of spans) {
    const first = lineOf(span.oldStart),
      last = lineOf(span.oldEnd - 1);
    const previous = blocks.at(-1);
    const delta = span.newEnd - span.newStart - (span.oldEnd - span.oldStart);
    if (previous && first <= previous.last) {
      previous.last = Math.max(previous.last, last);
      previous.shiftAfter += delta;
    } else blocks.push({ first, last, shiftBefore: shift, shiftAfter: shift + delta });
    shift += delta;
  }

  const out = [`--- a/${path}`, `+++ b/${path}`];
  let lineShift = 0;
  for (let index = 0; index < blocks.length;) {
    // Blocks whose context would touch share one hunk.
    let end = index;
    while (end + 1 < blocks.length && blocks[end + 1]!.first - blocks[end]!.last - 1 <= 2 * context) end++;
    const hunkFirst = Math.max(0, blocks[index]!.first - context);
    const hunkLast = Math.min(oldLines.length - 1, blocks[end]!.last + context);
    const body: string[] = [];
    let cursor = hunkFirst,
      added = 0;
    for (const block of blocks.slice(index, end + 1)) {
      for (; cursor < block.first; cursor++) body.push(" " + display(oldLines[cursor]!));
      const removed = splitLines(before.slice(starts[block.first], lineEnd(block.last)));
      const inserted = splitLines(after.slice(starts[block.first]! + block.shiftBefore, lineEnd(block.last) + block.shiftAfter));
      body.push(...removed.map((line) => "-" + display(line)), ...inserted.map((line) => "+" + display(line)));
      added += inserted.length - removed.length;
      cursor = block.last + 1;
    }
    for (; cursor <= hunkLast; cursor++) body.push(" " + display(oldLines[cursor]!));
    const oldCount = hunkLast - hunkFirst + 1;
    out.push(`@@ -${hunkFirst + 1},${oldCount} +${hunkFirst + 1 + lineShift},${oldCount + added} @@`, ...body);
    lineShift += added;
    index = end + 1;
  }
  return clip(out);
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function display(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function clip(lines: readonly string[]): string {
  let length = 0;
  for (const [index, line] of lines.entries()) {
    length += line.length + 1;
    if (length > DIFF_CHARS) return [...lines.slice(0, index), "…（diff 过长，后面的部分省略）"].join("\n");
  }
  return lines.join("\n");
}
