export const XIAOHEIHE_PATH = "/yesimbot/api/v1/connectors/xiaoheihe";

/** The 服务连接 page's Xiaoheihe card, shared by the server and the browser app. Never carries cookies or post content. */
export type XiaoheiheConnection =
  | { available: false }
  | {
      available: true;
      selfId: string;
      /** `connected`: the stored login works; `login_required`: scan the QR code; `connecting`/`error`: starting or broken (see the log). */
      state: "connecting" | "connected" | "login_required" | "error";
      paused: string | null;
      quarantinedPosts: number;
      newPostQuarantined: boolean;
      postsRemaining: number;
      interactionsRemaining: number;
      login: { state: "idle" | "pending" | "finished"; image?: string; message?: string };
    };
