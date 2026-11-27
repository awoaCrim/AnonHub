import type { Part } from "@yesimbot/contracts/parts";
import { vi } from "vitest";

import type { ChatAccount } from "../../src/accounts.js";

/** A chat account that records what it sends and answers with `message-<n>` IDs (override `sendMessage` to fail). */
export function testAccount(platform = "test", selfId = "bot-1") {
  let next = 0;
  const sent: Array<{ channelId: string; parts: readonly Part[] }> = [];
  const account = {
    platform,
    selfId,
    sent,
    sendMessage: vi.fn(async (channelId: string, parts: readonly Part[]): Promise<string[]> => {
      sent.push({ channelId, parts });
      return [`message-${++next}`];
    }),
  } satisfies ChatAccount & { sent: unknown };
  return account;
}
