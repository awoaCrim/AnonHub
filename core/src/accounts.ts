import type { Part } from "@yesimbot/contracts/parts";

/** Whether two handles are the same account instance; the host may know of wrappers (Koishi's context proxies). */
export type SameAccount = (left: ChatAccount, right: ChatAccount) => boolean;

/**
 * One of a platform's own operations (merged forwards, group management, the profile …; spec 09 rule 6): its input as
 * the platform defines it, resolving with the platform's answer and throwing when the platform refuses.
 */
export type ConnectorAction = (input: Readonly<Record<string, unknown>>) => Promise<unknown>;

/** What an account declares is all it offers: an action it does not list is not available there. */
export type ConnectorActions = Readonly<Record<string, ConnectorAction | undefined>>;

/**
 * The bot account a conversation speaks through, as the kernel uses it: who it is and how a message reaches the
 * platform. Under Koishi it is the adapter's Bot, whose members have these names; after Koishi it comes from a
 * connector (`.trellis/spec/conventions/09-connectors.md`). Message content is still Satori's element tree until the
 * kernel has its own `Part` model.
 */
export interface ChatAccount {
  readonly platform: string;
  readonly selfId: string;
  /** Sends one message; resolves with the platform's message IDs, which are the only delivery proof. */
  sendMessage(channelId: string, content: readonly Part[]): Promise<string[]>;
  /** The platform's own operations this account offers, by name (QQ: `ONEBOT_ACTIONS` in `@yesimbot/contracts/platforms`). */
  readonly actions?: ConnectorActions;
}

/** The web chat's account: it can also create a message carrying interface parts (choices). */
export interface WebChatAccount extends ChatAccount {
  createMessage(channelId: string, content: readonly Part[]): Promise<Array<{ readonly id?: string }>>;
}

export function isWebChatAccount(account: ChatAccount): account is WebChatAccount {
  return typeof (account as Partial<WebChatAccount>).createMessage === "function";
}
