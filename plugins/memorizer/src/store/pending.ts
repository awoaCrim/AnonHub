import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { newId, readJson, serialize, writeFileAtomic } from "@yesimbot/foundation";
import type { ChannelContext } from "koishi-plugin-yesimbot/kernel";
import { z } from "zod/v4";

import type { PendingMemory } from "../types.js";
import { normalizedContent, sameConversation } from "../visibility.js";

const PENDING_SCHEMA = z.array(z.custom<PendingMemory>((value) => typeof value === "object" && value !== null));

export class PendingStore {
  private readonly path: string;
  private pending: PendingMemory[] = [];

  public constructor(root: string) {
    this.path = join(root, "memory-pending.json");
  }

  public init(): Promise<void> {
    return serialize(this.path, async () => {
      this.pending = (await readJson(this.path, PENDING_SCHEMA)) ?? [];
    });
  }

  public list(): Promise<readonly PendingMemory[]> {
    return serialize(this.path, async () => [...this.pending]);
  }

  public enqueue(input: Omit<PendingMemory, "id" | "attempts" | "nextAttemptAt" | "suspended">, delayMs = 0): Promise<PendingMemory> {
    return serialize(this.path, async () => {
      const now = input.queuedAt;
      for (const item of this.pending) {
        if (sameChannel(item.channel, input.channel) && item.suspended) Object.assign(item, { suspended: false, nextAttemptAt: now });
      }
      const duplicate = this.pending.find(
        (item) =>
          sameChannel(item.channel, input.channel) &&
          item.turnId === input.turnId &&
          item.scope === input.scope &&
          normalizedContent(item.content) === normalizedContent(input.content) &&
          [...item.sources].sort().join("\u0000") === [...input.sources].sort().join("\u0000"),
      );
      if (duplicate) {
        await this.write();
        return duplicate;
      }
      const item: PendingMemory = { ...input, id: newId(), attempts: 0, nextAttemptAt: now + delayMs, suspended: false };
      this.pending.push(item);
      await this.write();
      return item;
    });
  }

  public nextBatch(channel: ChannelContext, maxPending: number, maxMessages: number): Promise<PendingMemory[]> {
    return serialize(this.path, async () => {
      const batch: PendingMemory[] = [];
      let messages = 0;
      for (const item of this.pending
        .filter((item) => !item.suspended && sameChannel(item.channel, channel))
        .sort((left, right) => left.queuedAt - right.queuedAt)) {
        if (batch.length >= maxPending) break;
        batch.push(item);
        messages += item.messageCount;
        if (messages > maxMessages) break;
      }
      return batch;
    });
  }

  public complete(ids: readonly string[]): Promise<void> {
    return serialize(this.path, async () => {
      const selected = new Set(ids);
      this.pending = this.pending.filter((item) => !selected.has(item.id));
      await this.write();
    });
  }

  public fail(ids: readonly string[], error: unknown, now: number, maxAttempts = 8): Promise<void> {
    return serialize(this.path, async () => {
      const selected = new Set(ids);
      const message = error instanceof Error ? error.message : String(error);
      for (const item of this.pending) {
        if (!selected.has(item.id)) continue;
        const attempts = item.attempts + 1;
        Object.assign(item, {
          attempts,
          lastError: message,
          nextAttemptAt: now + Math.min(60 * 60 * 1_000, 30_000 * 2 ** attempts),
          suspended: attempts >= maxAttempts,
        });
      }
      await this.write();
    });
  }

  public nextDueAt(): Promise<number | undefined> {
    return serialize(this.path, async () =>
      this.pending
        .filter((item) => !item.suspended)
        .reduce<number | undefined>((next, item) => (next === undefined || item.nextAttemptAt < next ? item.nextAttemptAt : next), undefined),
    );
  }

  private async write(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFileAtomic(this.path, `${JSON.stringify(this.pending)}\n`);
  }
}

function sameChannel(left: ChannelContext, right: ChannelContext): boolean {
  return sameConversation(left, right);
}
