const ASSET_ID = /^[a-f0-9]{32}$/;

/**
 * Message content (`.trellis/spec/conventions/09-connectors.md`, rule 2): what records store, what connectors send and
 * receive, and what Core renders for the model. Plain JSON; no Satori `Element`. The kinds Core understands are typed;
 * any other platform element (QQ `face`, `forward`, `json`, `mface`, `audio` …) is kept as a `platform` part so nothing
 * a platform sent is lost and its markup reads the same as before.
 */
export type Part = TextPart | MentionPart | ImagePart | FilePart | VideoPart | QuotePart | ChoicesPart | WorkspaceFilePart | PlatformPart;

export type PartType = Part["type"];

/** A value in a platform part's attributes, as stored. */
export type PartAttrValue = string | number | boolean | null | readonly PartAttrValue[] | { readonly [key: string]: PartAttrValue };

export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

/** `@` one person (`userId`, with the `name` the platform showed), or everyone (`scope`). */
export interface MentionPart {
  readonly type: "mention";
  readonly userId?: string;
  readonly name?: string;
  readonly scope?: "all" | "here";
}

/**
 * A picture. `asset` is the channel asset (32 hex) once stored; `failure` says why it could not be; `src` is a transport
 * source (a platform URL before storing, a `data:` URL on the way out) and is never kept in history.
 */
export interface ImagePart {
  readonly type: "image";
  readonly asset?: string;
  readonly src?: string;
  readonly title?: string;
  /** The platform's picture kind (QQ `subType`: 1 is a sticker). */
  readonly subtype?: string | number;
  readonly summary?: string;
  /** Going out: an animated sticker, which a platform sends as its own kind of picture. Never stored or shown to the model. */
  readonly sticker?: boolean;
  readonly failure?: string;
}

export interface FilePart {
  readonly type: "file";
  readonly asset?: string;
  readonly src?: string;
  readonly title?: string;
  readonly failure?: string;
}

export interface VideoPart {
  readonly type: "video";
  readonly asset?: string;
  readonly src?: string;
  readonly failure?: string;
}

/** A quoted message inside the content (the record's own quote is `MessageRecord.quote`). */
export interface QuotePart {
  readonly type: "quote";
  readonly messageId: string;
  readonly parts: readonly Part[];
}

/** Reply options offered with a web chat message. */
export interface ChoicesPart {
  readonly type: "choices";
  readonly options: readonly string[];
}

/** A file on the account holder's computer that a web chat message refers to (`workspace:///…`). */
export interface WorkspaceFilePart {
  readonly type: "workspace-file";
  readonly uri: string;
  readonly title?: string;
  readonly kind?: string;
}

/** Any other platform element, kept as the platform sent it. */
export interface PlatformPart {
  readonly type: "platform";
  readonly tag: string;
  readonly attrs: { readonly [key: string]: PartAttrValue };
  readonly parts: readonly Part[];
}

export interface PartsFromElementsOptions {
  /** Keep pictures', files' and videos' `src`: content on its way in (before storing) or out (model markup). */
  readonly sources?: boolean;
}

/** The element-shaped view of a part: the tag and attributes its markup uses. */
export interface PartElement {
  readonly type: string;
  readonly attrs: { readonly [key: string]: unknown };
  readonly children: readonly Part[];
}

export function isAssetId(value: unknown): value is string {
  return typeof value === "string" && ASSET_ID.test(value);
}

export function textPart(text: string): TextPart {
  return { type: "text", text };
}

/** Escapes text for element markup; `inline` also escapes quotes, for attribute values. */
export function escapeMarkup(source: string, inline = false): string {
  const result = source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return inline ? result.replace(/"/g, "&quot;") : result;
}

/**
 * One element as markup, `<tag a="1">…</tag>` or `<tag/>`: attribute names in kebab case, empty values left out, each
 * child string escaped as text. Byte for byte what history showed the model while elements were Satori's.
 */
export function markupTag(tag: string, attrs: { readonly [key: string]: unknown }, children: readonly string[]): string {
  return markupElement(
    tag,
    attrs,
    children.filter((child) => child !== "").map((child) => escapeMarkup(child)),
  );
}

/** Parts as markup, the way Satori wrote an element tree: text escaped, each other part a tag around its children's markup. */
export function partsMarkup(
  parts: readonly Part[],
  mapAttrs: (attrs: { readonly [key: string]: unknown }) => { readonly [key: string]: unknown } = (attrs) => attrs,
): string {
  return parts
    .map((part) => {
      if (part.type === "text") return escapeMarkup(part.text);
      const element = partElement(part);
      return markupElement(
        element.type,
        mapAttrs(element.attrs),
        element.children.map((child) => partsMarkup([child], mapAttrs)),
      );
    })
    .join("");
}

/** The tag and attributes each part has in markup. */
export function partElement(part: Exclude<Part, TextPart>): PartElement {
  switch (part.type) {
    case "mention":
      return { type: "at", attrs: part.scope ? { type: part.scope } : { id: part.userId, name: part.name }, children: [] };
    case "image":
      return {
        type: "img",
        attrs: { id: part.asset, src: part.src, title: part.title, subType: part.subtype, summary: part.summary, yesimbotFailure: part.failure },
        children: [],
      };
    case "file":
      return { type: "file", attrs: { id: part.asset, src: part.src, title: part.title, yesimbotFailure: part.failure }, children: [] };
    case "video":
      return { type: "video", attrs: { id: part.asset, src: part.src, yesimbotFailure: part.failure }, children: [] };
    case "quote":
      return { type: "quote", attrs: { id: part.messageId }, children: part.parts };
    case "choices":
      return { type: "web-choices", attrs: { options: part.options }, children: [] };
    case "workspace-file":
      return { type: "web-file", attrs: { uri: part.uri, title: part.title, kind: part.kind }, children: [] };
    case "platform":
      return { type: part.tag, attrs: part.attrs, children: part.parts };
  }
}

/**
 * Parts from Satori-shaped elements `{ type, attrs, children }`: stored history (plain JSON) and Koishi's live elements
 * alike. Kinds Core understands become typed parts when their attributes are the usual ones; everything else becomes a
 * `platform` part with its attributes as they were.
 */
export function partsFromElements(values: readonly unknown[] | undefined, options: PartsFromElementsOptions = {}): Part[] {
  return (values ?? []).flatMap((value) => {
    const part = partFromElement(value, options);
    return part ? [part] : [];
  });
}

/** Plain text of parts, for searching and summaries: text verbatim, mentions as `@name`, children in order. */
export function partsPlainText(parts: readonly Part[]): string {
  return parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "mention") return `@${part.name ?? part.userId ?? ""}`;
      if (part.type === "quote" || part.type === "platform") return partsPlainText(part.parts);
      return "";
    })
    .join("");
}

/** `inner` is each child's markup; an element without children closes itself. */
function markupElement(tag: string, attrs: { readonly [key: string]: unknown }, inner: readonly string[]): string {
  // Names are camel-cased into one object first, as Satori did: two spellings of one name keep the last value.
  const named: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(attrs)) if (value !== null && value !== undefined) named[camelCase(rawKey)] = value;
  let attributes = "";
  for (const [camelKey, value] of Object.entries(named)) {
    const key = paramCase(camelKey);
    if (value === true) attributes += ` ${key}`;
    else if (value === false) attributes += ` no-${key}`;
    else attributes += ` ${key}="${escapeMarkup(String(value), true)}"`;
  }
  return inner.length ? `<${tag}${attributes}>${inner.join("")}</${tag}>` : `<${tag}${attributes}/>`;
}

function partFromElement(value: unknown, options: PartsFromElementsOptions): Part | undefined {
  if (typeof value === "string") return value ? textPart(value) : undefined;
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  const type = value.type;
  const attrs = isRecord(value.attrs) ? value.attrs : {};
  const children = Array.isArray(value.children) ? partsFromElements(value.children, options) : [];
  const source = options.sources && typeof attrs.src === "string" ? { src: attrs.src } : {};
  const keys = Object.keys(attrs).filter((key) => attrs[key] !== undefined && attrs[key] !== null);
  const only = (...allowed: string[]) => keys.every((key) => allowed.includes(key));
  // Kinds whose markup lists their attributes keep them in this order; another order stays a platform part.
  const ordered = (...canonical: string[]) => keys.join(",") === canonical.filter((key) => keys.includes(key)).join(",");
  const text = (key: string) => (typeof attrs[key] === "string" ? (attrs[key] as string) : undefined);
  const leaf = children.length === 0;
  switch (type) {
    case "text":
      if ("content" in attrs && leaf && only("content")) return textPart(attrs.content === null || attrs.content === undefined ? "" : String(attrs.content));
      break;
    case "at":
      if (leaf && keys.length === 1 && (attrs.type === "all" || attrs.type === "here")) return { type: "mention", scope: attrs.type };
      if (leaf && typeof attrs.id === "string" && ordered("id", "name") && (attrs.name === undefined || attrs.name === null || typeof attrs.name === "string"))
        return { type: "mention", userId: attrs.id, ...(text("name") === undefined ? {} : { name: text("name")! }) };
      break;
    case "img":
      // Only the asset, its title and the failure reach the model; transport attributes are not history.
      if (leaf) {
        const subtype = attrs.subType ?? attrs.sub_type;
        return {
          type: "image",
          ...(isAssetId(attrs.id) ? { asset: attrs.id } : {}),
          ...source,
          ...(text("title") === undefined ? {} : { title: text("title")! }),
          ...(typeof subtype === "string" || typeof subtype === "number" ? { subtype } : {}),
          ...(text("summary") === undefined ? {} : { summary: text("summary")! }),
          ...(text("yesimbotFailure") === undefined ? {} : { failure: text("yesimbotFailure")! }),
        };
      }
      break;
    case "file":
      if (leaf) {
        const title = storedFileName(attrs);
        return {
          type: "file",
          ...(isAssetId(attrs.id) ? { asset: attrs.id } : {}),
          ...source,
          ...(title === undefined ? {} : { title }),
          ...(text("yesimbotFailure") === undefined ? {} : { failure: text("yesimbotFailure")! }),
        };
      }
      break;
    case "video":
      if (leaf)
        return {
          type: "video",
          ...(isAssetId(attrs.id) ? { asset: attrs.id } : {}),
          ...source,
          ...(text("yesimbotFailure") === undefined ? {} : { failure: text("yesimbotFailure")! }),
        };
      break;
    case "quote":
      if (typeof attrs.id === "string" && ordered("id")) return { type: "quote", messageId: attrs.id, parts: children };
      break;
    case "web-choices":
      if (leaf && ordered("options") && Array.isArray(attrs.options) && attrs.options.every((option) => typeof option === "string"))
        return { type: "choices", options: attrs.options as string[] };
      break;
    case "web-file":
      if (
        leaf &&
        typeof attrs.uri === "string" &&
        ordered("uri", "title", "kind") &&
        [attrs.title, attrs.kind].every((item) => item === undefined || item === null || typeof item === "string")
      )
        return {
          type: "workspace-file",
          uri: attrs.uri,
          ...(text("title") === undefined ? {} : { title: text("title")! }),
          ...(text("kind") === undefined ? {} : { kind: text("kind")! }),
        };
      break;
  }
  return { type: "platform", tag: type, attrs: plainAttrs(attrs), parts: children };
}

/** OneBot calls the file name `file`; other adapters use `title` or `name`. URLs are not names. */
function storedFileName(attrs: Record<string, unknown>): string | undefined {
  for (const key of ["title", "name", "file"]) {
    const value = attrs[key];
    if (typeof value === "string" && value.trim() && !/^(?:https?|data|base64|file):/i.test(value)) return value;
  }
  return undefined;
}

function plainAttrs(attrs: Record<string, unknown>): { [key: string]: PartAttrValue } {
  const result: { [key: string]: PartAttrValue } = {};
  for (const [key, value] of Object.entries(attrs)) {
    const plain = plainValue(value);
    if (plain !== undefined) result[key] = plain;
  }
  return result;
}

function plainValue(value: unknown): PartAttrValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) return value.map((item) => plainValue(item) ?? null);
  if (isRecord(value)) return plainAttrs(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** cosmokit `camelCase`, which Satori applied to every attribute name. */
function camelCase(source: string): string {
  return source.replace(/[_-][a-z]/g, (match) => match.slice(1).toUpperCase());
}

/** cosmokit `paramCase`, which Satori applied when writing attribute names. */
function paramCase(source: string): string {
  let output = "";
  let state: "delimiter" | "upper" | "lower" = "delimiter";
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code >= 65 && code <= 90) {
      if (state === "upper") {
        const next = source.charCodeAt(index + 1);
        if (next >= 97 && next <= 122) output += "-";
      } else if (state !== "delimiter") output += "-";
      output += String.fromCharCode(code + 32);
      state = "upper";
    } else if (code >= 97 && code <= 122) {
      output += source[index];
      state = "lower";
    } else if (code === 45 || code === 95) {
      if (state !== "delimiter") output += "-";
      state = "delimiter";
    } else output += source[index];
  }
  return output;
}
