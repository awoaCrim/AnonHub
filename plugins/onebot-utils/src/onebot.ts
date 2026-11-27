export interface OneBotSenderInfo {
  readonly user_id: number | string;
  readonly nickname?: string;
  readonly card?: string;
}

export interface OneBotCQCode {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface OneBotForwardSendNode {
  readonly type: "node";
  readonly data: { readonly name: string; readonly uin: string; readonly content: readonly OneBotCQCode[]; readonly time: string };
}

/** The forward calls this plugin makes over the account's OneBot actions. */
export interface OneBotCalls {
  /** The forward's nodes; anything but a list when QQ has none. */
  getForwardMsg(forwardId: string): Promise<unknown>;
  getImage(file: string): Promise<{ readonly url?: string } | undefined>;
}
