import { type ChannelContext, type ChannelKey, deriveChannelKey } from "./channels/index.js";

/**
 * Choices one conversation makes apart from the shared configuration — the web chat's own role card
 * and reply model. Absent fields follow the configuration. They live in memory; their owner (the web
 * chat) sets them again whenever Core starts.
 */
export interface ChannelOverride {
  /** Full chat model ID; ignored while that model is not registered. */
  chatModel?: string;
  /** Role card path as listed by the roleplay plugin; "" means no role card. */
  roleCard?: string;
}

export class ChannelOverrides {
  private readonly values = new Map<ChannelKey, ChannelOverride>();
  /** `release` drops the conversation's live runtime so its next turn is built with the new choice. */
  public constructor(private readonly release: (context: ChannelContext) => Promise<void>) {}

  public get(context: ChannelContext): ChannelOverride | undefined {
    return this.values.get(deriveChannelKey(context));
  }

  public async set(context: ChannelContext, value: ChannelOverride | undefined): Promise<void> {
    const key = deriveChannelKey(context);
    const next: ChannelOverride = {
      ...(value?.chatModel ? { chatModel: value.chatModel } : {}),
      ...(value?.roleCard !== undefined ? { roleCard: value.roleCard } : {}),
    };
    const previous = this.values.get(key);
    if (JSON.stringify(previous ?? {}) === JSON.stringify(next)) return;
    if (Object.keys(next).length) this.values.set(key, next);
    else this.values.delete(key);
    await this.release(context);
  }
}
