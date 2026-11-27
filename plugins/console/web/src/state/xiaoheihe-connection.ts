import { reactive } from "vue";

import { XIAOHEIHE_PATH, type XiaoheiheConnection } from "../../../src/shared/xiaoheihe";
import { api, ApiError } from "../lib/api";

export function xiaoheiheError(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "";
  return (
    (
      {
        xiaoheihe_unavailable: "小黑盒扩展没有运行，请先在「能力」里启用它。",
        owner_required: "只有主人能登录小黑盒。",
      } as Record<string, string>
    )[code] ?? "小黑盒暂时无法连接，请稍后重试。"
  );
}

/**
 * Page-local state of the 小黑盒 card. Updates replace the data in place (no blank-and-reload), and the card
 * only polls while a QR login is waiting for a scan or the connection is still starting.
 */
export function createXiaoheiheConnection(options: { request?: typeof api; interval?: number } = {}) {
  const request = options.request ?? api;
  const state = reactive({ connection: undefined as XiaoheiheConnection | undefined, loading: false, busy: false, error: "" });
  const controller = new AbortController();
  let disposed = false,
    generation = 0,
    timer: ReturnType<typeof setTimeout> | undefined;

  const waiting = () => {
    const value = state.connection;
    return !!value?.available && (value.login.state === "pending" || value.state === "connecting");
  };
  function schedule() {
    clearTimeout(timer);
    if (!disposed && waiting()) timer = setTimeout(() => void load(), options.interval ?? 2000);
  }
  async function load() {
    const current = ++generation;
    state.loading = true;
    try {
      const result = await request<XiaoheiheConnection>(XIAOHEIHE_PATH, undefined, { fresh: true, signal: controller.signal });
      if (disposed || current !== generation) return;
      state.connection = result;
      state.error = "";
    } catch (error) {
      if (!disposed && current === generation) state.error = xiaoheiheError(error);
    } finally {
      if (!disposed && current === generation) state.loading = false;
    }
    schedule();
  }
  /** Starts the QR login; the image arrives through the polling that follows. */
  async function login() {
    if (disposed || state.busy) return;
    state.busy = true;
    try {
      const result = await request<XiaoheiheConnection>(`${XIAOHEIHE_PATH}/login`, {}, { signal: controller.signal });
      if (disposed) return;
      generation++;
      state.connection = result;
      state.error = "";
    } catch (error) {
      if (!disposed) state.error = xiaoheiheError(error);
    } finally {
      if (!disposed) state.busy = false;
    }
    schedule();
  }
  function dispose() {
    disposed = true;
    clearTimeout(timer);
    controller.abort();
  }
  return { state, load, login, dispose };
}
