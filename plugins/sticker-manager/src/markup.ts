import type { parseMarkup } from "koishi-plugin-yesimbot/kernel";

export type MarkupElement = ReturnType<typeof parseMarkup>[number];

/** An element written back as the markup the model reads: attribute names in kebab case, text escaped. */
export function element(type: string, attrs: Record<string, unknown>, children: MarkupElement[] = []): MarkupElement {
  return { type, attrs, children };
}

export function serializeMarkup(elements: readonly MarkupElement[]): string {
  return elements.map(serializeElement).join("");
}

function serializeElement(node: MarkupElement): string {
  if (node.type === "text") return escapeText(String(node.attrs.content ?? ""));
  const attrs = Object.entries(node.attrs)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => serializeAttribute(kebabCase(key), value))
    .join("");
  if (node.children.length === 0) return `<${node.type}${attrs}/>`;
  return `<${node.type}${attrs}>${serializeMarkup(node.children)}</${node.type}>`;
}

function serializeAttribute(key: string, value: unknown): string {
  if (value === true) return ` ${key}`;
  if (value === false) return ` no-${key}`;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return ` ${key}="${escapeText(text).replaceAll('"', "&quot;")}"`;
}

function kebabCase(source: string): string {
  return source.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function escapeText(source: string): string {
  return source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
