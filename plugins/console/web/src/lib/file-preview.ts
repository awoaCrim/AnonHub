/** Rows a table shows; the rest is in the download. */
export const TABLE_ROWS = 2_000;

/** Text past this is shown plain: highlighting it would hold the page up. */
const HIGHLIGHT_LIMIT = 150_000;

/** Escapes text for `v-html`. */
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Code as highlighted HTML; highlight.js loads the first time it is needed. A language it does not know stays plain. */
export async function highlightCode(code: string, language: string | undefined): Promise<string> {
  if (!language || code.length > HIGHLIGHT_LIMIT) return escapeHtml(code);
  const hljs = (await import("highlight.js/lib/common")).default;
  return hljs.getLanguage(language) ? hljs.highlight(code, { language, ignoreIllegals: true }).value : escapeHtml(code);
}

/** JSON indented two spaces; JSON Lines line by line. Text that does not parse comes back as it was. */
export function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    const lines = text.split(/\r?\n/);
    try {
      return lines.map((line) => (line.trim() ? JSON.stringify(JSON.parse(line), null, 2) : line)).join("\n");
    } catch {
      return text;
    }
  }
}

/** A CSV or TSV file's rows, the first being the header, up to `TABLE_ROWS` after it. */
export async function parseTable(text: string, delimiter: string): Promise<{ rows: string[][]; more: boolean }> {
  const Papa = (await import("papaparse")).default;
  const { data } = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: "greedy", preview: TABLE_ROWS + 2 });
  return { rows: data.slice(0, TABLE_ROWS + 1), more: data.length > TABLE_ROWS + 1 };
}
