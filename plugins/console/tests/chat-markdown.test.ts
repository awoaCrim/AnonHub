import { expect, it } from "vitest";

import { renderMarkdown } from "../web/src/lib/markdown.js";
it("renders nested structure, scrollable tables and code without interpreting code HTML", () => {
  const html = renderMarkdown("1. one\n   - child\n\n| A | B |\n|---|---|\n|x|y|\n\n```html\n<script>alert(1)</script>\n```");
  expect(html).toContain("<ol>");
  expect(html).toContain("<ul>");
  expect(html).toContain('class="table-scroll"');
  expect(html).toContain('class="copy-code"');
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
});
it("does not execute raw HTML or javascript links or load remote images automatically", () => {
  const html = renderMarkdown("<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n![test](https://example.org/track.png)");
  expect(html).not.toContain("<img");
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain('rel="noopener noreferrer"');
});
it("keeps multiple code blocks independent", () => {
  const html = renderMarkdown("```js\na\n```\n\n```js\nb\n```");
  expect(html.match(/class="copy-code"/g)).toHaveLength(2);
});
it("wraps every table cell so it sizes to content and keeps column alignment", () => {
  const html = renderMarkdown("| 节点 | CPU |\n|:---|---:|\n| 韩国·首尔 `Tencent,KR` | 4.2% |");
  expect(html).toContain('<th style="text-align:left"><div class="table-cell">节点</div></th>');
  expect(html).toContain('<td style="text-align:right"><div class="table-cell">4.2%</div></td>');
  expect(html).toContain('<div class="table-cell">韩国·首尔 <code>Tencent,KR</code></div>');
  expect(html.match(/class="table-cell"/g)).toHaveLength(4);
});
