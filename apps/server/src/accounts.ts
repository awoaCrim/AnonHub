import { AppError, defineErrors } from "@yesimbot/foundation";
import type { ChatAccount } from "koishi-plugin-yesimbot/kernel";

export const ACCOUNT_ERRORS = defineErrors({
  host_account_duplicate: { model: "同一个账号接入了两次。", user: "同一个账号接入了两次。", status: 409 },
});

/** The chat accounts connectors bring online, by platform and account ID. */
export class Accounts {
  private readonly accounts = new Map<string, ChatAccount>();

  public register(account: ChatAccount): () => void {
    const key = accountKey(account.platform, account.selfId);
    if (this.accounts.has(key)) throw new AppError(ACCOUNT_ERRORS.host_account_duplicate, { effect: "none", detail: key });
    this.accounts.set(key, account);
    return () => {
      if (this.accounts.get(key) === account) this.accounts.delete(key);
    };
  }

  public find(platform: string, selfId: string): ChatAccount | undefined {
    return this.accounts.get(accountKey(platform, selfId));
  }

  /** The account a shared conversation of `platform` belongs to: this host has no group assignment, so the platform's only one. */
  public sole(platform: string): ChatAccount | undefined {
    const matching = this.list().filter((account) => account.platform === platform);
    return matching.length === 1 ? matching[0] : undefined;
  }

  public list(): ChatAccount[] {
    return [...this.accounts.values()];
  }
}

function accountKey(platform: string, selfId: string): string {
  return `${platform}\u0000${selfId}`;
}
