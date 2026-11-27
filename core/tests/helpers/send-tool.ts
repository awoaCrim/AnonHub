import { createMemoryStorage, type AgentTool } from "@yesimbot/agent-runtime";

import type { ChatAccount } from "../../src/accounts.js";
import { createReplyTools } from "../../src/agents/reply-tools.js";
import { beginReplyJournal } from "../../src/conversations/reply-journal.js";
import type { ChannelResources } from "../../src/resources/index.js";

/** The production `send_message` tool with an in-memory reply journal, for tests outside a channel runtime. */
export function createTestSendTool(options: { bot: ChatAccount; channelId: string; resources: ChannelResources }): AgentTool {
  const storage = createMemoryStorage();
  let invocations = 0;
  return createReplyTools({
    ...options,
    pacing: { charactersPerSecond: 10_000, maxTotalDelayMs: 0 },
    innerThought: false,
    journal: {
      begin: (input) =>
        beginReplyJournal({
          ...input,
          invocationId: `invocation-${++invocations}`,
          sessionId: "session",
          generation: 1,
          sink: { append: (entry) => storage.append(entry).then(() => {}) },
        }),
    },
  }).tools[0]!;
}
