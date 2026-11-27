import { readFileSync } from "node:fs";

import { markupTag, partsFromElements, partsMarkup, type Part } from "@yesimbot/contracts/parts";
import { describe, expect, it } from "vitest";

import { parseMarkup } from "../src/messages/markup.js";
import { compactPartsText, formatPart, formatPartWithImages } from "../src/messages/parts.js";
import { h } from "./helpers/index.js";

/**
 * Golden data recorded from the Satori-era renderers and parser (core/src/messages/index.ts and compact.ts, `h.parse`,
 * `String(h(...))`), 2026-11-24, when records still held Satori elements. The oracle is gone with Koishi; these are its answers.
 */
interface Row {
  input: { type: string; attrs: Record<string, unknown>; children?: unknown[] };
  format: string;
  quoted: Record<string, string>;
  images: { out: string; ids: string[] };
  images2: { out: string; ids: string[] };
  compact: string;
  markup: string | null;
}
const golden = JSON.parse(readFileSync(new URL("./fixtures/parts-parity.json", import.meta.url), "utf8")) as {
  markup: Array<{ tag: string; attrs: Record<string, unknown>; children: string[]; out: string }>;
  elements: Row[];
  random: Row[];
  parseFixed: Array<{ source: string; parsed: unknown }>;
  parseRandom: Array<{ source: string; parsed: unknown }>;
};

const ASSET = "0123456789abcdef0123456789abcdef";

function convert(input: Row["input"]): Part {
  const parts = partsFromElements([input]);
  expect(parts).toHaveLength(1);
  return parts[0]!;
}

function expectRow(row: Row, quotes: readonly string[], images: boolean) {
  const part = convert(row.input);
  expect({ input: row.input, output: formatPart(part) }).toEqual({ input: row.input, output: row.format });
  for (const quotedMessageId of quotes) expect(formatPart(part, quotedMessageId)).toBe(row.quoted[quotedMessageId]);
  if (images) {
    const ids: string[] = [];
    expect({ input: row.input, output: formatPartWithImages(part, "m-2", ids, "#n#") }).toEqual({ input: row.input, output: row.images.out });
    expect(ids).toEqual(row.images.ids);
  }
  const ids: string[] = [];
  expect(formatPartWithImages(part, undefined, ids, "#")).toBe(row.images2.out);
  expect(ids).toEqual(row.images2.ids);
  expect(compactPartsText([part])).toBe(row.compact);
}

describe("Part rendering matches the Satori-era model view", () => {
  it("writes element markup exactly as Satori did", () => {
    expect(golden.markup).toHaveLength(60);
    for (const { tag, attrs, children, out } of golden.markup) expect(markupTag(tag, attrs, children)).toBe(out);
  });

  it("renders every stored shape as before, as text, with image bytes and in compaction summaries", () => {
    expect(golden.elements.length).toBeGreaterThan(40);
    for (const row of golden.elements) expectRow(row, ["m-1", "m-2", "m-3"], true);
  });

  it("writes a part tree as Satori wrote the element tree", () => {
    const rows = golden.elements.filter((row) => row.markup !== null);
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows) expect({ input: row.input, output: partsMarkup([convert(row.input)]) }).toEqual({ input: row.input, output: row.markup });
  });

  it("types the kinds Core understands and keeps any other element as it was", () => {
    const element = (input: ReturnType<typeof h>) => convert(JSON.parse(JSON.stringify(input)) as Row["input"]);
    expect(element(h("at", { id: "1", name: "n" }))).toEqual({ type: "mention", userId: "1", name: "n" });
    expect(element(h("at", { type: "all" }))).toEqual({ type: "mention", scope: "all" });
    expect(element(h("img", { id: ASSET, subType: 1, summary: "[动画表情]" }))).toEqual({ type: "image", asset: ASSET, subtype: 1, summary: "[动画表情]" });
    expect(element(h("file", { src: "https://x.test/f", file: "report.pdf", fileSize: "100" }))).toEqual({ type: "file", title: "report.pdf" });
    expect(element(h("video", { yesimbotFailure: "too_large" }))).toEqual({ type: "video", failure: "too_large" });
    expect(element(h("web-choices", { options: ["是"] }))).toEqual({ type: "choices", options: ["是"] });
    expect(element(h("face", { id: "14", name: "微笑", platform: "onebot" }, [h("img", { id: ASSET })]))).toEqual({
      type: "platform",
      tag: "face",
      attrs: { id: "14", name: "微笑", platform: "onebot" },
      parts: [{ type: "image", asset: ASSET }],
    });
    // Another attribute order would read differently, so it is kept as it was.
    expect(element(h("at", { name: "反序", id: "2" }))).toMatchObject({ type: "platform", tag: "at" });
    expect(partsFromElements(["裸字符串", 3, null, { attrs: {} }])).toEqual([{ type: "text", text: "裸字符串" }]);
  });

  it("matches random element trees", () => {
    expect(golden.random).toHaveLength(400);
    for (const row of golden.random) expectRow(row, ["m-1"], false);
  });
});

describe("model markup is read as Satori's h.parse read it", () => {
  const read = (source: string) => JSON.parse(JSON.stringify(parseMarkup(source))) as unknown;

  it("reads what models write", () => {
    expect(golden.parseFixed.length).toBeGreaterThan(20);
    for (const { source, parsed } of golden.parseFixed) expect({ source, parsed: read(source) }).toEqual({ source, parsed });
  });

  it("matches random markup", () => {
    expect(golden.parseRandom).toHaveLength(400);
    for (const { source, parsed } of golden.parseRandom) expect({ source, parsed: read(source) }).toEqual({ source, parsed });
  });
});
