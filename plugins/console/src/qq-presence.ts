/**
 * NapCat's own word on whether its QQ account is online. When QQ is kicked offline NapCat keeps its OneBot link up,
 * so Koishi still sees the bot online; only NapCat's login service knows (2026-11-23: the owner's QQ was offline
 * for hours while 平台 showed a green dot).
 */
export class QQPresence {
  /** The QQ number NapCat reports logged in but offline; `""` when offline with the number unknown. */
  private offline?: string;

  update(report: { offline: boolean; accountId?: string } | undefined): void {
    // An unreadable login service says nothing either way: keep the last answer.
    if (!report) return;
    this.offline = report.offline ? (report.accountId ?? "") : undefined;
  }

  /** Whether the OneBot account `selfId` is the one NapCat reports offline. */
  isOffline(selfId: string): boolean {
    return this.offline !== undefined && (this.offline === "" || this.offline === selfId);
  }
}
