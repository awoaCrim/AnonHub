import { reactive } from "vue";

import { GOOGLE_PATH, type GoogleSelection, type GoogleSnapshot } from "../../../src/shared/google";
import { api, ApiError } from "../lib/api";
import { onCacheRefresh } from "../lib/cache";

export function googleError(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "";
  return (
    (
      {
        not_permitted: "服务器尚未为这个账号开放 Google 服务，请联系管理员。",
        google_app_not_configured: "请先完成 Google 应用设置，再连接账号。",
        google_login_busy: "进行中的授权过多，请稍后再试。",
        google_account_limit: "最多连接 8 个 Google 账号，请先断开不再使用的连接。",
        google_account_not_found: "这个连接已被移除，请刷新。",
        google_invalid_client_id: "Client ID 格式不对，应以 .apps.googleusercontent.com 结尾。",
        google_invalid_client_secret: "Client Secret 格式不对，请从 Google Cloud 重新复制。",
        google_invalid_input: "填写的内容有误，请检查后重试。",
        owner_required: "只有主人能设置 Google 应用。",
      } as Record<string, string>
    )[code] ?? "Google 服务暂时无法连接，请稍后重试。"
  );
}

/** Page-local requests; navigation and late results stop when the page is left. */
export function createGoogleConnections(options: { request?: typeof api; navigate?: (url: string) => void } = {}) {
  const request = options.request ?? api;
  const state = reactive({ snapshot: undefined as GoogleSnapshot | undefined, loading: false, busy: "", error: "" });
  const controller = new AbortController();
  let generation = 0,
    disposed = false;
  async function load(fresh = false) {
    const current = ++generation;
    state.loading = true;
    try {
      const result = await request<GoogleSnapshot>(GOOGLE_PATH, undefined, { fresh, signal: controller.signal });
      if (disposed || current !== generation) return;
      state.snapshot = result;
      state.error = "";
    } catch (error) {
      if (!disposed && current === generation) state.error = googleError(error);
    } finally {
      if (!disposed && current === generation) state.loading = false;
    }
  }

  const stopRefresh = onCacheRefresh((path) => {
    if (path === GOOGLE_PATH && !disposed && !state.loading && !state.busy) void load();
  });

  /** `account`: changing or renewing that account's access, so Google opens on it. */
  async function connect(selection: GoogleSelection, account?: string) {
    if (disposed || state.busy) return;
    state.busy = "connect";
    try {
      const result = await request<{ authorizationUrl: string }>(
        `${GOOGLE_PATH}/authorize`,
        { services: selection, ...(account ? { account } : {}) },
        { signal: controller.signal },
      );
      const url = new URL(result.authorizationUrl);
      if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password)
        throw new Error("invalid_authorization_url");
      if (!disposed) (options.navigate ?? ((target) => location.assign(target)))(url.href);
    } catch (error) {
      if (!disposed) state.error = googleError(error);
    } finally {
      if (!disposed) state.busy = "";
    }
  }

  /** The owner's own app, shared with every friend. An empty secret keeps the saved one. Resolves whether it was saved. */
  async function saveApp(app: { clientId: string; clientSecret?: string; redirectUri: string }): Promise<boolean> {
    if (disposed || state.busy) return false;
    state.busy = "app";
    try {
      await request(`${GOOGLE_PATH}/app`, app, { signal: controller.signal });
      if (disposed) return false;
      await load(true);
      return true;
    } catch (error) {
      if (!disposed) state.error = googleError(error);
      return false;
    } finally {
      if (!disposed) state.busy = "";
    }
  }

  async function disconnect(id: string): Promise<{ revoked: boolean } | undefined> {
    if (disposed || state.busy) return;
    state.busy = id;
    try {
      const result = await request<{ revoked: boolean }>(`${GOOGLE_PATH}/disconnect`, { id }, { signal: controller.signal });
      if (disposed) return;
      if (state.snapshot) state.snapshot.accounts = state.snapshot.accounts.filter((account) => account.id !== id);
      await load(true);
      return result;
    } catch (error) {
      if (!disposed) state.error = googleError(error);
    } finally {
      if (!disposed) state.busy = "";
    }
  }
  return {
    state,
    load,
    connect,
    saveApp,
    disconnect,
    dispose() {
      stopRefresh();
      disposed = true;
      generation++;
      controller.abort();
    },
  };
}
