/** WeChat login through the agent-wechat daemon in the same runtime container. */
export interface WechatLoginStatus {
  /** The daemon answered. */
  available: boolean;
  loggedIn: boolean;
  /** Logged in and connected to WeChat right now. */
  online: boolean;
  /** The logged-in account's wxid. */
  accountId?: string;
  /** The login this console started, while the daemon still knows it. */
  login?: WechatLoginAttempt;
}

export interface WechatLoginAttempt {
  /** `awaiting_scan`, `awaiting_approval` (scanned, waiting for the phone's confirmation), `succeeded`… */
  state: string;
  /** Present while a QR code can be fetched; a new generation means the daemon replaced an expired code. */
  qrGeneration?: number;
  /** WeChat asked the phone to reach this device on the local network. */
  lan?: boolean;
  /** Why the login ended without signing in, as a fixed category. */
  problem?: "expired" | "rejected" | "lan" | "failed";
}

export interface WechatQrCode {
  image: string;
  generation: number;
}
