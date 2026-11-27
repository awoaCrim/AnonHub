import { partElement, partsFromElements, type Part } from "@yesimbot/contracts/parts";
import { WEB_CHAT, webChatConversation, webChatUser } from "@yesimbot/contracts/platforms";
import { AppError, detectImageType, newId, type Clock } from "@yesimbot/foundation";
import { CHANNEL_TYPE, parseMarkupParts, type ChannelContext, type CoreService, type WebChatAccount } from "koishi-plugin-yesimbot/kernel";

import { WEB_CHAT_TRANSPORT, webConversationContext, type ProjectedAttachment, type ProjectedChat, type WebChatTransport } from "./chat-bot.js";

/** A Satori-shaped element, as `partsFromElements` reads it. */
interface ElementView {
  readonly type: string;
  readonly attrs: Readonly<Record<string, unknown>>;
  readonly children: readonly ElementView[];
}

/**
 * The web chat as a connector (convention 09), under any host: the owner's messages become records Core admits, and
 * what the bot sends to a web conversation is recorded there. Only this runtime's authenticated HTTP ingress calls
 * `receive`. `apps/server` registers it as an account.
 */
export class WebChat implements WebChatTransport, WebChatAccount {
  public readonly [WEB_CHAT_TRANSPORT] = true;
  public readonly platform = WEB_CHAT.platform;
  public readonly selfId = WEB_CHAT.selfId;

  /** Kept in this trusted transport; never serialized into records, prompts or tool arguments. */
  private readonly authenticated = new Map<string, () => boolean>();

  public constructor(
    private readonly core: CoreService,
    /** A bot message was written to this conversation. */
    private readonly changed: (conversation: string) => void,
    private readonly clock: Clock,
    /** Whether the account is online . */
    private readonly online: () => boolean,
  ) {}

  public isOnline(): boolean {
    return this.online();
  }

  /** One owner message: resolves once Core has admitted and stored it, and rethrows a refusal. */
  public async receive(
    username: string,
    text: string,
    messageId: string,
    timestamp: number,
    conversation = "",
    files: readonly { uri?: string; asset?: string; name: string; kind: string }[] = [],
    authenticated?: () => boolean,
  ): Promise<void> {
    if (authenticated) this.authenticated.set(conversation, authenticated);
    const id = webChatUser(conversation);
    // An image is shown to the bot from the conversation's assets; its copy on the computer, or a file, by reference.
    const elements: ElementView[] = [
      element("text", { content: text }),
      ...files.flatMap((file) => [
        ...(file.asset ? [element("img", { id: file.asset, title: file.name })] : []),
        ...(file.uri ? [element("web-file", { uri: file.uri, title: file.name, kind: file.kind })] : []),
      ]),
    ];
    const context: ChannelContext = { type: "direct", platform: WEB_CHAT.platform, channelId: id, selfId: WEB_CHAT.selfId, userId: id, userName: username };
    await this.core.messenger.accept(
      {
        context,
        selfId: WEB_CHAT.selfId,
        routeId: messageId,
        translate: async (resources) => ({
          platform: WEB_CHAT.platform,
          selfId: WEB_CHAT.selfId,
          timestamp,
          channel: { id, type: CHANNEL_TYPE.direct },
          user: { id, name: username },
          messageId,
          // Uploads are already the conversation's assets or workspace files: nothing is downloaded.
          parts: await resources.persistParts(partsFromElements(elements, { sources: true }), async () => {
            throw new AppError("media_download_failed", { effect: "none" });
          }),
        }),
      },
      true,
    );
  }

  /** Fresh authentication check shared by instance services and private owner memory. */
  public isAuthenticatedContext(context: ChannelContext): boolean {
    if (
      !this.online() ||
      context.type !== "direct" ||
      context.platform !== WEB_CHAT.platform ||
      context.selfId !== WEB_CHAT.selfId ||
      context.channelId !== context.userId
    )
      return false;
    const conversation = webChatConversation(context.userId);
    if (conversation === undefined) return false;
    try {
      return this.authenticated.get(conversation)?.() === true;
    } catch {
      return false;
    }
  }

  /** Bind one operation to the ingress session that authorized it, even if a later login sends another message. */
  public captureAuthentication(context: ChannelContext): () => boolean {
    const conversation = context.type === "direct" ? webChatConversation(context.userId) : undefined;
    const grant = conversation === undefined ? undefined : this.authenticated.get(conversation);
    return () => {
      try {
        return this.isAuthenticatedContext(context) && grant?.() === true;
      } catch {
        return false;
      }
    };
  }

  /** A transport from another runtime cannot administer this ConfigStore. The Core-owned identity object is stable. */
  public belongsToRuntime(core: CoreService): boolean {
    return !!core.identity && this.core.identity === core.identity;
  }

  public async sendMessage(channelId: string, content: readonly Part[]): Promise<string[]> {
    return (await this.createMessage(channelId, content)).map((message) => message.id);
  }

  /** Records what the bot sent in the conversation (the delivery proof is the new message's ID). */
  public async createMessage(
    channelId: string,
    content: readonly Part[],
  ): Promise<Array<{ readonly id: string; readonly timestamp: number; readonly parts: Part[] }>> {
    const conversation = webChatConversation(channelId);
    if (conversation === undefined || !this.online()) throw new Error("web_chat_target_denied");
    const id = newId();
    const timestamp = this.clock.now();
    const context = webConversationContext(conversation);
    const projected = projectChatParts(content);
    const assets = await this.core.resource.get(context).then(
      (resources) => resources.assets,
      () => undefined,
    );
    // Only what Core already read for this send (a data: URL) is kept, in the conversation's own assets.
    // A remote, file or other URL is never fetched, recorded or shown.
    const attachments = await Promise.all(
      projected.attachments.map(async (item) => {
        const type = item.kind === "image" ? "img" : "file";
        const bytes = dataUrlBytes(item.src);
        if (!bytes || !assets || (item.kind === "image" && !detectImageType(bytes))) return element(type, { title: item.name });
        return assets.put(bytes).then(
          (asset) => element(type, { id: asset, title: item.name }),
          () => element(type, { title: item.name }),
        );
      }),
    );
    const parts = partsFromElements([
      element("text", { content: projected.text }),
      ...attachments,
      ...(projected.choices.length ? [element("web-choices", { options: projected.choices })] : []),
    ]);
    await this.core.conversation.recordSent(context, { messageId: id, timestamp, parts });
    this.changed(conversation);
    return [{ id, timestamp, parts }];
  }
}

/** A saved web chat message (markup) as text, attachments and choices. */
export function projectChatContent(content: string): ProjectedChat {
  return projectChatParts(parseMarkupParts(content));
}

/** Parts as the web chat shows them: text, attachments (by name) and up to four clickable replies. */
export function projectChatParts(parts: readonly Part[]): ProjectedChat {
  const attachments: ProjectedAttachment[] = [];
  const choices: string[] = [];
  const walk = (items: readonly Part[]): string =>
    items
      .map((part) => {
        if (part.type === "text") return part.text;
        const view = partElement(part);
        // Clickable replies under the message: never part of its text.
        if (view.type === "web-choices") {
          choices.push(...chatChoices(view.attrs.options));
          return "";
        }
        if (["img", "image", "file", "audio", "video", "web-file"].includes(view.type)) {
          const kind = view.type === "img" || view.type === "image" || (view.type === "web-file" && view.attrs.kind === "image") ? "image" : "file";
          const raw = String(view.attrs.title ?? view.attrs.name ?? (kind === "image" ? "图片" : "文件"));
          const source = view.type === "web-file" ? { uri: view.attrs.uri } : { src: view.attrs.src };
          attachments.push({
            kind,
            name: raw.split(/[/\\]/).at(-1)!.slice(0, 200) || (kind === "image" ? "图片" : "文件"),
            ...(typeof source.uri === "string" ? { uri: source.uri } : {}),
            ...(typeof source.src === "string" ? { src: source.src } : {}),
          });
          return "";
        }
        if (view.type === "at") return `@${view.attrs.name ?? view.attrs.id ?? ""}`;
        if (view.type === "br") return "\n";
        if (view.type === "quote") return "";
        return walk(view.children);
      })
      .join("");
  return { text: walk(parts), attachments, choices: choices.slice(0, 4) };
}

/** At most four distinct short options, as the web send_message offers them. */
export function chatChoices(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const options = value.filter((item): item is string => typeof item === "string").map((item) => item.trim());
  return [...new Set(options.filter((item) => item && [...item].length <= 40))].slice(0, 4);
}

function element(type: string, attrs: Record<string, unknown>): ElementView {
  return { type, attrs, children: [] };
}

/** The bytes of a base64 `data:` URL of at most 8 MiB; anything else is not read. */
function dataUrlBytes(src: string | undefined): Buffer | undefined {
  const match = src && src.length <= 12 * 1024 * 1024 ? /^data:[^;,]*;base64,([A-Za-z0-9+/]*={0,2})$/.exec(src) : undefined;
  const bytes = match ? Buffer.from(match[1]!, "base64") : undefined;
  return bytes?.length ? bytes : undefined;
}
