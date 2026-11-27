import { expect, it } from "vitest";

import { escapeHtml, formatJson, highlightCode, parseTable, TABLE_ROWS } from "../web/src/lib/file-preview.js";
import { fileFormat } from "../web/src/lib/file-types.js";

// User, 2026-11-26: 「查看文件的弹窗也要优化一下，比如需要支持各个格式md，json等」.
it("tells how to show a file from its name", () => {
  expect(fileFormat("blackfive-2026-vps-audit.md")).toEqual({ view: "markdown", label: "MD" });
  expect(fileFormat("Config.JSON")).toEqual({ view: "json", label: "JSON" });
  expect(fileFormat("events.jsonl").view).toBe("json");
  expect(fileFormat("ports.csv")).toEqual({ view: "table", label: "CSV", delimiter: "," });
  expect(fileFormat("ports.tsv").delimiter).toBe("\t");
  expect(fileFormat("check_ports.py")).toEqual({ view: "code", label: "PY", language: "python" });
  expect(fileFormat("Dockerfile")).toEqual({ view: "code", label: "", language: "dockerfile" });
  expect(fileFormat("report.pdf")).toEqual({ view: "pdf", label: "PDF", type: "application/pdf" });
  expect(fileFormat("voice.mp3").view).toBe("audio");
  expect(fileFormat("clip.webm")).toEqual({ view: "video", label: "WEBM", type: "video/webm" });
  expect(fileFormat("backup.tar.gz")).toEqual({ view: "archive", label: "GZ" });
  expect(fileFormat("notes.txt").view).toBe("text");
  expect(fileFormat("README").view).toBe("text");
  expect(fileFormat("data.bin")).toEqual({ view: "other", label: "BIN" });
});

it("indents JSON and JSON Lines, and leaves anything else as it was", () => {
  expect(formatJson('{"a":[1,{"b":null}]}')).toBe('{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ]\n}');
  expect(formatJson('{"a":1}\n{"b":2}\n')).toBe('{\n  "a": 1\n}\n{\n  "b": 2\n}\n');
  expect(formatJson("{ not json")).toBe("{ not json");
});

it("highlights code it knows and escapes everything it shows", async () => {
  const html = await highlightCode('def run():\n    return "<b>"', "python");
  expect(html).toContain('<span class="hljs-keyword">def</span>');
  expect(html).toContain("&lt;b&gt;");
  expect(html).not.toContain("<b>");
  expect(await highlightCode("<script>alert(1)</script>", "no-such-language")).toBe(escapeHtml("<script>alert(1)</script>"));
  expect(await highlightCode("<i>", undefined)).toBe("&#60;i&#62;");
});

it("reads a CSV with quoted cells into rows, up to the shown limit", async () => {
  expect(await parseTable('port,note\n443,"TLS 1.3, HTTP/2"\n\n', ",")).toEqual({
    rows: [
      ["port", "note"],
      ["443", "TLS 1.3, HTTP/2"],
    ],
    more: false,
  });
  const long = ["n", ...Array.from({ length: TABLE_ROWS + 5 }, (_, i) => String(i))].join("\n");
  const table = await parseTable(long, ",");
  expect(table.rows).toHaveLength(TABLE_ROWS + 1);
  expect(table.more).toBe(true);
});
