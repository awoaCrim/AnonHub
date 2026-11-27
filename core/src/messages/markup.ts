import { partsFromElements, type Part } from "@yesimbot/contracts/parts";

const TAG = /(?<comment><!--[\s\S]*?-->)|(?<tag><(\/?)([^!\s>/]*)([^>]*?)\s*(\/?)>)/;
const ATTR = /([^\s=]+)(?:="(?<value1>[^"]*)"|='(?<value2>[^']*)')?/g;
const FRAGMENT = "template";

/** An element as markup describes it, before it becomes a part. */
export interface MarkupElement {
  readonly type: string;
  readonly attrs: Record<string, unknown>;
  readonly children: MarkupElement[];
}

interface Token {
  readonly name: string;
  readonly position: "open" | "close" | "empty";
  readonly extra: string;
  children?: Array<string | Token>;
}

/**
 * The element syntax the model writes (`<at id="1"/>`, `<quote id="m"/>`, `<img src="asset://…"/>`, entities), read
 * the way Satori's `h.parse` read it: a stray closing tag is ignored, an unclosed tag takes the rest, a newline with its
 * surrounding blanks at either end of a text run is dropped, attribute names become camel case.
 */
export function parseMarkup(source: string): MarkupElement[] {
  const tokens: Array<string | Token> = [];
  let rest = source;
  for (let match = TAG.exec(rest); match; match = TAG.exec(rest)) {
    pushText(tokens, rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
    if (match.groups?.comment) continue;
    const [, , , close, type, extra, empty] = match;
    tokens.push({ name: type || FRAGMENT, position: close ? "close" : empty ? "empty" : "open", extra: extra ?? "" });
  }
  pushText(tokens, rest);
  return elementsOf(fold(tokens));
}

/** Model markup as parts; pictures and files keep the source they name, for delivery to read. */
export function parseMarkupParts(source: string): Part[] {
  return partsFromElements(parseMarkup(source), { sources: true });
}

/** Undoes `escapeMarkup`, and numeric references except to `&`, as Satori did. */
export function unescapeMarkup(source: string): string {
  return source
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (match, code: string) => (code === "38" ? match : String.fromCharCode(Number(code))))
    .replace(/&#x([0-9a-f]+);/gi, (match, code: string) => (code === "26" ? match : String.fromCharCode(parseInt(code, 16))))
    .replace(/&(amp|#38|#x26);/g, "&");
}

function pushText(tokens: Array<string | Token>, raw: string): void {
  const text = unescapeMarkup(raw)
    .replace(/^\s*\n\s*/, "")
    .replace(/\s*\n\s*$/, "");
  if (text) tokens.push(text);
}

function fold(tokens: readonly (string | Token)[]): Array<string | Token> {
  const root: Token = { name: FRAGMENT, position: "open", extra: "", children: [] };
  const stack: Token[] = [root];
  for (const token of tokens) {
    const top = stack[0]!;
    if (typeof token === "string") top.children!.push(token);
    else if (token.position === "close") {
      if (top.name === token.name) stack.shift();
    } else if (token.position === "open") {
      top.children!.push(token);
      token.children = [];
      stack.unshift(token);
    } else top.children!.push(token);
  }
  return root.children!;
}

function elementsOf(tokens: readonly (string | Token)[]): MarkupElement[] {
  const result: MarkupElement[] = [];
  for (const token of tokens) {
    if (typeof token === "string") {
      result.push({ type: "text", attrs: { content: token }, children: [] });
      continue;
    }
    const raw: Record<string, unknown> = {};
    ATTR.lastIndex = 0;
    for (let match = ATTR.exec(token.extra); match; match = ATTR.exec(token.extra)) {
      const [, key, quoted, single] = match;
      const value = single ?? quoted;
      if (value !== undefined) raw[key!] = unescapeMarkup(value);
      else if (key!.startsWith("no-")) raw[key!.slice(3)] = false;
      else raw[key!] = true;
    }
    const attrs: Record<string, unknown> = {};
    const children: MarkupElement[] = token.children ? elementsOf(token.children) : [];
    for (const [key, value] of Object.entries(raw)) {
      // Satori read a `children` attribute as content after the element's own.
      if (key === "children") {
        const content = String(value);
        if (content) children.push({ type: "text", attrs: { content }, children: [] });
      } else attrs[camelCase(key)] = value;
    }
    result.push({ type: token.name, attrs, children });
  }
  return result;
}

function camelCase(source: string): string {
  return source.replace(/[_-][a-z]/g, (match) => match.slice(1).toUpperCase());
}
