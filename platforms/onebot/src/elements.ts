import qface from "qface";

const CQ_CODE = /\[CQ:(\w+)((,\w+=[^,\]]*)*)\]/;

/** What NapCat posts as a message's content: the array form, or the CQ-code string. */
export type OneBotMessage = readonly OneBotSegment[] | string;

/**
 * A Satori-shaped element, plain JSON: what Koishi's adapter-onebot 6.9.4 made of NapCat's segments, and what
 * `partsFromElements` reads. Records made from these views match the ones the Koishi path stored, byte for byte.
 */
export interface ElementView {
  readonly type: string;
  readonly attrs: Record<string, unknown>;
  readonly children: readonly ElementView[];
}

/** One OneBot 11 message segment. */
export interface OneBotSegment {
  readonly type: string;
  readonly data?: Record<string, unknown>;
}

/** A message's elements as adapter-onebot decoded them, and the ID of the message a leading reply points at. */
export interface DecodedMessage {
  readonly elements: ElementView[];
  readonly replyId?: unknown;
}

/**
 * NapCat's message as adapter-onebot decoded it (`adaptMessage`): segments into elements, a space either side of
 * each picture (its `splitMixedContent`, on by default), media URLs as `src`, faces with their name and picture, and
 * a leading reply taken out. `undefined` when there is no message to read, where the adapter dropped the event.
 */
export function decodeMessage(message: unknown): DecodedMessage | undefined {
  if (typeof message !== "string" && !Array.isArray(message)) return undefined;
  const chain = typeof message === "string" ? parseCQCode(message) : (message as readonly OneBotSegment[]).map(segmentElement);
  splitMixedContent(chain);
  const elements = chain.map(transformSegment);
  if (elements[0]?.type !== "reply") return { elements };
  const [reply, ...rest] = elements;
  return { elements: rest, replyId: reply!.attrs.id };
}

/**
 * Satori's `h(type, props, children)`: names camel-cased (a later spelling of the same name keeps the first one's
 * place), empty values left out, `children` taken as children.
 */
export function element(type: string, props: Record<string, unknown> = {}, children: readonly ElementView[] = []): ElementView {
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || key === "children") continue;
    attrs[camelize(key)] = value;
  }
  return { type, attrs, children: [...children] };
}

/** cosmokit `camelize`, which Satori applies to every attribute name. */
export function camelize(source: string): string {
  return source.replace(/[_-][a-z]/g, (match) => match.slice(1).toUpperCase());
}

function segmentElement(segment: OneBotSegment): ElementView {
  const data = segment?.data ?? {};
  return segment?.type === "text" ? element("text", { content: data.text }) : element(String(segment?.type), data);
}

function parseCQCode(source: string): ElementView[] {
  const elements: ElementView[] = [];
  let rest = source;
  for (let capture = CQ_CODE.exec(rest); capture; capture = CQ_CODE.exec(rest)) {
    const [whole, type, attrs] = capture;
    if (capture.index) elements.push(element("text", { content: unescapeCQ(rest.slice(0, capture.index)) }));
    const data: Record<string, string> = {};
    if (attrs)
      for (const pair of attrs.slice(1).split(",")) {
        const index = pair.indexOf("=");
        data[pair.slice(0, index)] = unescapeCQ(pair.slice(index + 1));
      }
    elements.push(element(type!, data));
    rest = rest.slice(capture.index + whole.length);
  }
  if (rest) elements.push(element("text", { content: unescapeCQ(rest) }));
  return elements;
}

function unescapeCQ(source: string): string {
  return source.replace(/&#91;/g, "[").replace(/&#93;/g, "]").replace(/&#44;/g, ",").replace(/&amp;/g, "&");
}

function splitMixedContent(chain: ElementView[]): void {
  chain.forEach((item, index) => {
    if (item.type !== "image") return;
    const left = chain[index - 1];
    if (left?.type === "text" && typeof left.attrs.content === "string" && left.attrs.content.trimEnd() === left.attrs.content) left.attrs.content += " ";
    const right = chain[index + 1];
    if (right?.type === "text" && typeof right.attrs.content === "string" && right.attrs.content.trimStart() === right.attrs.content)
      right.attrs.content = " " + right.attrs.content;
  });
}

function transformSegment(segment: ElementView): ElementView {
  const { attrs } = segment;
  switch (segment.type) {
    case "at":
      if (attrs.qq === "all") return element("at", { type: "all" });
      return element("at", { id: attrs.qq, name: attrs.name });
    case "face": {
      const face = qface.get(attrs.id as string) as { QDes: string } | undefined;
      return element("face", { id: attrs.id, name: face?.QDes.slice(1), platform: "onebot" }, [element("img", { src: qface.getUrl(attrs.id as string) })]);
    }
    case "image":
      return media("img", attrs);
    case "record":
      return media("audio", attrs);
    case "video":
      return media("video", attrs);
    case "file":
      return media("file", attrs);
    default:
      return element(segment.type, attrs, segment.children.map(transformSegment));
  }
}

/** The URL as `src`, falling back to the file name; every other field kept. */
function media(type: string, attrs: Record<string, unknown>): ElementView {
  const { url: _url, ...rest } = attrs;
  return element(type, { src: attrs.url || attrs.file, ...rest });
}
