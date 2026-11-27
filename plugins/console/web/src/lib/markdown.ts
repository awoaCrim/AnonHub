import MarkdownIt from "markdown-it";

/** Raw HTML stays literal; unsafe URL schemes are rejected by markdown-it. */
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
const linkOpen = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index]!.attrSet("target", "_blank");
  tokens[index]!.attrSet("rel", "noopener noreferrer");
  return linkOpen ? linkOpen(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
};
// Generated remote images are links. Actual attachments use the authenticated asset route.
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index]!;
  return `<a href="${markdown.utils.escapeHtml(String(token.attrGet("src") ?? ""))}" target="_blank" rel="noopener noreferrer">${markdown.utils.escapeHtml(token.content || "查看图片")}</a>`;
};
const fence = markdown.renderer.rules.fence!;
const block = markdown.renderer.rules.code_block!;
const codeShell = (html: string) => `<div class="code-block"><button type="button" class="copy-code" aria-label="复制代码">复制</button>${html}</div>`;
markdown.renderer.rules.fence = (...args) => codeShell(fence(...args));
markdown.renderer.rules.code_block = (...args) => codeShell(block(...args));
markdown.renderer.rules.table_open = () => '<div class="table-scroll" tabindex="0" role="region" aria-label="表格"><table>';
markdown.renderer.rules.table_close = () => "</table></div>";
// Cells size to their content up to a cap (`.table-cell` in ChatMarkdown.vue); a wider table scrolls instead of
// squeezing every column until words and code break letter by letter.
for (const cell of ["th", "td"] as const) {
  markdown.renderer.rules[`${cell}_open`] = (tokens, index, options, _env, self) => `${self.renderToken(tokens, index, options)}<div class="table-cell">`;
  markdown.renderer.rules[`${cell}_close`] = (tokens, index, options, _env, self) => `</div>${self.renderToken(tokens, index, options)}`;
}
export const renderMarkdown = (text: string): string => markdown.render(text);
