import { fileURLToPath } from "node:url";

import { partElement, type Part } from "@yesimbot/contracts/parts";

import { element, type ElementView, type OneBotSegment } from "./elements.js";

export const PRIVATE_PREFIX = "private:";

/** What NapCat shows for an animated emoji (`sub_type` 1). */
const ANIMATED_STICKER_SUMMARY = "[动画表情]";

const ONEBOT_SEGMENTS = new Set(["music", "tts", "poke", "gift", "share", "json", "xml", "cardimage"]);

/** mime-db's first extension for the types Core sends untitled; Koishi named a `data:` file `file.<extension>`. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  "application/json": "json",
  "application/octet-stream": "bin",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "image/gif": "gif",
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "text/csv": "csv",
  "text/html": "html",
  "text/markdown": "md",
  "text/plain": "txt",
};

/** The actions sending needs (adapter-onebot's `internal`, which converts `*_id` arguments). */
export interface EncoderActions {
  /** The answer's `data`; a failed answer throws. */
  call(action: string, params: Record<string, unknown>): Promise<unknown>;
  /** The account's own name and QQ number, for a forwarded node without an author. */
  readonly self: { readonly name?: string; readonly id: string };
  readonly now: () => number;
}

interface State {
  readonly type: "message" | "forward";
  readonly author: Record<string, unknown>;
  readonly children: OneBotSegment[];
}

class Encoder {
  private readonly stack: State[] = [state("message")];
  private children: OneBotSegment[] = [];
  private readonly results: string[] = [];
  private readonly direct: boolean;

  public constructor(
    private readonly actions: EncoderActions,
    private readonly channelId: string,
  ) {
    this.direct = channelId.startsWith(PRIVATE_PREFIX);
  }

  public async send(elements: readonly ElementView[]): Promise<string[]> {
    await this.render(elements);
    await this.flush();
    return this.results;
  }

  private get target(): string {
    return this.direct ? this.channelId.slice(PRIVATE_PREFIX.length) : this.channelId;
  }

  private async render(elements: readonly ElementView[]): Promise<void> {
    for (const child of elements) await this.visit(child);
  }

  private text(text: string): void {
    this.children.push({ type: "text", data: { text } });
  }

  private async visit(view: ElementView): Promise<void> {
    const { type, attrs, children } = view;
    const top = this.stack[0]!;
    if (type === "text") this.text(attrs.content as string);
    else if (type === "br") this.text("\n");
    else if (type === "p") {
      const previous = this.children.at(-1);
      if (previous?.type === "text") {
        if (!String(previous.data!.text).endsWith("\n")) previous.data!.text += "\n";
      } else this.text("\n");
      await this.render(children);
      this.text("\n");
    } else if (type === "at") {
      this.children.push({ type: "at", data: attrs.type === "all" ? { qq: "all" } : { qq: attrs.id, name: attrs.name } });
    } else if (type === "sharp") {
      if (attrs.id) this.text(attrs.id as string);
    } else if (type === "face") {
      if (attrs.platform && attrs.platform !== "onebot") await this.render(children);
      else this.children.push({ type: "face", data: { id: attrs.id } });
    } else if (type === "a") {
      await this.render(children);
      if (attrs.href) this.text(`（${String(attrs.href)}）`);
    } else if (type === "video" || type === "audio" || type === "image" || type === "img") {
      if (type === "video" || type === "audio") await this.flush();
      const data: Record<string, unknown> = { ...attrs };
      data.file = attrs.src || attrs.url;
      delete data.src;
      delete data.url;
      data.cache = attrs.cache ? 1 : 0;
      const inline = typeof data.file === "string" ? /^data:([\w/.+-]+);base64,/.exec(data.file) : null;
      if (inline) data.file = "base64://" + (data.file as string).slice(inline[0].length);
      this.children.push({ type: type === "audio" ? "record" : type === "img" ? "image" : type, data });
    } else if (type === "file") {
      await this.flush();
      await this.sendFile(attrs);
    } else if (type.startsWith("onebot:") && ONEBOT_SEGMENTS.has(type.slice("onebot:".length))) {
      await this.flush();
      this.children.push({ type: type.slice("onebot:".length), data: attrs });
    } else if (type === "author") Object.assign(top.author, attrs);
    else if (type === "figure") await this.forward(children);
    else if (type === "quote") {
      await this.flush();
      this.children.push({ type: "reply", data: attrs });
    } else if (type === "message") {
      await this.flush();
      if ("forward" in attrs) await this.forward(children, false);
      else if ("id" in attrs) top.author.messageId = String(attrs.id);
      else {
        for (const key of ["userId", "username", "nickname", "time"]) if (key in attrs) top.author[key] = attrs[key];
        await this.render(children);
        await this.flush();
      }
    } else await this.render(children);
  }

  private async forward(children: readonly ElementView[], flushFirst = true): Promise<void> {
    if (flushFirst) await this.flush();
    this.stack.unshift(state("forward"));
    await this.render(children);
    await this.flush();
    this.stack.shift();
    const nodes = this.stack[0]!.children;
    if (!nodes.length) return;
    const action = this.direct ? "send_private_forward_msg" : "send_group_forward_msg";
    this.results.push(messageId(await this.actions.call(action, { [this.direct ? "user_id" : "group_id"]: this.target, messages: nodes })));
  }

  private async flush(): Promise<void> {
    while (this.children[0]?.type === "text") {
      const first = this.children[0];
      first.data!.text = String(first.data!.text).trimStart();
      if (first.data!.text) break;
      this.children.shift();
    }
    while (this.children.at(-1)?.type === "text") {
      const last = this.children.at(-1)!;
      last.data!.text = String(last.data!.text).trimEnd();
      if (last.data!.text) break;
      this.children.pop();
    }
    const { type, author } = this.stack[0]!;
    if (!this.children.length && !author.messageId) return;
    if (type === "forward") {
      this.stack[1]!.children.push(
        author.messageId
          ? { type: "node", data: { id: author.messageId } }
          : {
              type: "node",
              data: {
                name: author.name || this.actions.self.name,
                uin: author.id || this.actions.self.id,
                content: this.children,
                time: `${Math.floor((Number(author.time) || this.actions.now()) / 1000)}`,
              },
            },
      );
      this.children = [];
      return;
    }
    await this.sendMessage(this.children);
    this.children = [];
  }

  private async sendMessage(message: readonly OneBotSegment[]): Promise<void> {
    const action = this.direct ? "send_private_msg" : "send_group_msg";
    this.results.push(messageId(await this.actions.call(action, { [this.direct ? "user_id" : "group_id"]: this.target, message })));
  }

  /**
   * A file goes as a message of its own file segment, not `upload_*_file` as adapter-onebot sent it: NapCat sends both
   * the same way (`createValidSendFileElement`, then `sendMsgWithOb11UniqueId`), but only `send_*_msg` answers with the
   * message's ID; `upload_*_file` answers with the file's (spec 09 rule 3).
   */
  private async sendFile(attrs: Record<string, unknown>): Promise<void> {
    const src = String(attrs.src || attrs.url);
    const name = (attrs.title as string | undefined) || fileName(src);
    const file = src.startsWith("file:") ? fileURLToPath(src) : ((await this.actions.call("download_file", { url: src })) as { file?: unknown }).file;
    await this.sendMessage([{ type: "file", data: { file, name } }]);
  }
}

/**
 * Parts as adapter-onebot 6.9.4 sent them (`OneBotMessageEncoder`), so QQ gets what it got under Koishi: text, mentions,
 * faces and pictures go out together; a quote, file, voice or video starts a new message; `<figure>` and
 * `<message forward>` send merged forwards. A file goes as a file segment (`sendFile`). Resolves with each sent
 * message's ID, `""` where QQ answered without one (Core then treats that message as unconfirmed).
 */
export async function sendParts(actions: EncoderActions, channelId: string, parts: readonly Part[]): Promise<string[]> {
  return new Encoder(actions, channelId).send(outgoingElements(parts));
}

/**
 * Parts as the Satori elements the Koishi shell handed the adapter (then Satori's `transform`, which
 * camel-cases every attribute name and drops empty values).
 */
export function outgoingElements(parts: readonly Part[]): ElementView[] {
  return parts.map((part) => {
    if (part.type === "text") return element("text", { content: part.text });
    if (part.type === "image" && part.sticker) return element("img", { src: part.src, name: part.title, summary: ANIMATED_STICKER_SUMMARY, sub_type: 1 });
    const view = partElement(part);
    return element(view.type, view.attrs as Record<string, unknown>, outgoingElements(view.children));
  });
}

/** The name Koishi's `http.file` gave a file without a title: `file.<extension>` for `data:`, else the URL's last segment. */
function fileName(src: string): string {
  const inline = /^data:([\w/.+-]+);base64,/.exec(src);
  if (inline) return EXTENSIONS[inline[1]!] ? `file.${EXTENSIONS[inline[1]!]}` : "file";
  return /.+\/([^/?]*)(?=\?)?/.exec(src)?.[1] || "file";
}

/** The ID in a send's answer; `""` when there is none, never `"undefined"`. */
function messageId(data: unknown): string {
  const id = (data as { message_id?: unknown } | null | undefined)?.message_id;
  return (typeof id === "number" && Number.isFinite(id)) || (typeof id === "string" && id) ? String(id) : "";
}

function state(type: State["type"]): State {
  return { type, author: {}, children: [] };
}
