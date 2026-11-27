import type { Part } from "@yesimbot/contracts/parts";
import { partsPlainText } from "@yesimbot/contracts/parts";
import { vi } from "vitest";

import type { ChatAccount } from "../../../../core/src/accounts.js";
import type { ChannelContext } from "../../../../core/src/channels/index.js";
import { YesImBotCore } from "../../../../core/src/core.js";
import { TestEvents } from "../../../../core/tests/helpers/events.js";

/** A chat account that records the text of what it sends. */
export function textAccount(platform = "onebot", selfId = "bot-1") {
  const sent: string[] = [];
  let next = 0;
  const account = {
    platform,
    selfId,
    sent,
    status: 1,
    sendMessage: vi.fn(async (_channelId: string, parts: readonly Part[]): Promise<string[]> => {
      sent.push(partsPlainText([...parts]));
      return [`sent-${++next}`];
    }),
  };
  return account satisfies ChatAccount & { sent: string[] };
}

/** Core on the kernel host: the accounts a test registers and the one account every shared conversation is assigned to. */
export function kernelCore(baseDir: string, config: unknown) {
  const events = new TestEvents();
  const accounts: ChatAccount[] = [];
  const assigned = { selfId: undefined as string | undefined };
  const core = new YesImBotCore({
    baseDir,
    config,
    events,
    account: (platform, selfId) => accounts.find((account) => account.platform === platform && account.selfId === selfId),
    assignee: async () => assigned.selfId,
  } as never);
  return { core, events, accounts, assigned };
}

/** One platform message, as a connector hands it to Core: addressed to the account when `mention` is set. */
export async function receive(
  core: YesImBotCore,
  input: { context: ChannelContext; text: string; messageId: string; userName?: string; mention?: boolean },
): Promise<void> {
  const { context } = input;
  const userId = context.type === "direct" ? context.userId : "member-1";
  await core.messenger.accept({
    context,
    selfId: context.selfId!,
    routeId: input.messageId,
    translate: async () => ({
      platform: context.platform,
      selfId: context.selfId!,
      timestamp: Date.now(),
      channel: { id: context.channelId, type: context.type === "direct" ? 1 : 0 },
      user: { id: userId, name: input.userName ?? "用户" },
      messageId: input.messageId,
      parts: [...(input.mention ? [{ type: "mention" as const, userId: context.selfId! }] : []), { type: "text" as const, text: input.text }],
    }),
  });
}
