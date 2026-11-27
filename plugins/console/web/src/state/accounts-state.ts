import { reactive } from "vue";

import type { AccountResponse, AccountsResponse, AccountView, CreateAccountInput, RuntimeResponse, RuntimeView } from "../../../src/shared/accounts";
import { adminRequest } from "../lib/admin-request";

export const runtimeLabels: Record<RuntimeView["state"], string> = {
  "setup-required": "等待启动",
  starting: "正在准备",
  running: "运行中",
  stopping: "正在停止",
  stopped: "已停止",
  error: "准备失败",
};

type Request = typeof adminRequest;

/** Login details to hand to a friend, shown once right after creating them or resetting their password. */
export interface FriendLogin {
  username: string;
  password: string;
  reason: "created" | "reset";
}

/** A random password without look-alike characters, long enough for the 12-character minimum. */
export function generatePassword(length = 16): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
}

export function createAccountsState(request: Request = adminRequest) {
  const state = reactive({
    accounts: [] as AccountView[],
    busy: false,
    error: "",
    notice: "",
    username: "",
    password: "",
    qqAccount: "",
    resetId: "",
    resetPassword: "",
    /** Grant for the next created account; null lets the server grant every optional plugin. */
    plugins: null as string[] | null,
    pluginsId: "",
    pluginsDraft: [] as string[],
    /** Only while the share block is on screen; cleared when it is closed, by the next create/reset and on leaving the page. */
    share: null as FriendLogin | null,
  });
  let disposed = false;
  async function perform(action: () => Promise<void>) {
    if (disposed || state.busy) return;
    state.busy = true;
    state.error = "";
    state.notice = "";
    try {
      await action();
    } catch (cause) {
      if (!disposed) state.error = failure(cause);
    } finally {
      if (!disposed) state.busy = false;
    }
  }

  function replace(account: AccountView) {
    if (disposed) return;
    const index = state.accounts.findIndex((item) => item.id === account.id);
    if (index < 0) state.accounts.push(account);
    else state.accounts[index] = account;
  }
  return {
    state,
    refresh: () =>
      perform(async () => {
        const result = await request<AccountsResponse>("admin/accounts");
        if (!disposed) state.accounts = result.accounts;
      }),
    create: () =>
      perform(async () => {
        const password = state.password;
        state.share = null;
        const input: CreateAccountInput = {
          username: state.username.trim(),
          password: state.password,
          ...(state.qqAccount.trim() ? { qqAccount: state.qqAccount.trim() } : {}),
          ...(state.plugins ? { plugins: [...state.plugins] } : {}),
        };
        try {
          const result = await request<AccountResponse>("admin/accounts", input);
          if (!disposed) {
            replace(result.account);
            state.username = "";
            state.qqAccount = "";
            state.share = { username: result.account.username, password, reason: "created" };
            state.notice = "好友已添加。把登录信息发给好友就行。";
          }
        } finally {
          state.password = "";
        }
      }),
    enabled: (account: AccountView) =>
      perform(async () => {
        const result = await request<AccountResponse>(`admin/accounts/${encodeURIComponent(account.id)}/enabled`, { enabled: !account.enabled });
        replace(result.account);
        if (!disposed)
          state.notice =
            !result.account.enabled && !["stopped", "setup-required"].includes(result.account.runtime.state)
              ? "已停用，好友原来的登录已失效，数据保留。好友的 bot 还没确认停止，请刷新状态后检查。"
              : "状态已更新，原来的登录已失效；数据保留。";
      }),
    /** Resolves true once the friend, their bot, computer and data are gone. */
    remove: async (account: AccountView) => {
      let done = false;
      await perform(async () => {
        await request(`admin/accounts/${encodeURIComponent(account.id)}/delete`, { username: account.username });
        done = true;
        if (disposed) return;
        state.accounts = state.accounts.filter((item) => item.id !== account.id);
        state.notice = `已删除 ${account.username}：bot、电脑和数据都清理了。`;
      });
      return done;
    },
    reset: () =>
      perform(async () => {
        const id = state.resetId,
          password = state.resetPassword;
        state.share = null;
        try {
          await request(`admin/accounts/${encodeURIComponent(id)}/password`, { password });
          if (!disposed) {
            state.resetId = "";
            const username = state.accounts.find((account) => account.id === id)?.username;
            if (username) state.share = { username, password, reason: "reset" };
            state.notice = "密码已重置，原来的登录已失效。";
          }
        } finally {
          state.resetPassword = "";
        }
      }),
    /** Saves a friend's granted features; true once the server kept them. */
    async savePlugins(id: string, plugins: string[]) {
      let saved = false;
      await perform(async () => {
        const result = await request<AccountResponse & { message?: string }>(`admin/accounts/${encodeURIComponent(id)}/plugins`, { plugins });
        replace(result.account);
        saved = true;
        if (!disposed && result.message === "runtime_policy_sync_failed") state.notice = "已保存，好友的 bot 下次启动时生效。";
      });
      return saved;
    },
    dispose: () => {
      disposed = true;
      state.password = "";
      state.resetPassword = "";
      state.share = null;
    },
  };
}

export function createRuntimeState(request: Request = adminRequest) {
  const state = reactive({ runtime: null as RuntimeView | null, qqAccount: "", loading: false, submitting: false, error: "", refreshError: "" });
  let disposed = false;
  let revision = 0;
  async function refresh() {
    if (disposed || state.loading || state.submitting) return;
    const current = revision;
    state.loading = true;
    try {
      const result = await request<RuntimeResponse>("account/runtime");
      if (!disposed && current === revision) {
        state.runtime = result.runtime;
        state.refreshError = "";
      }
    } catch (cause) {
      if (!disposed && current === revision) state.refreshError = failure(cause);
    } finally {
      if (!disposed) state.loading = false;
    }
  }

  async function start() {
    if (disposed || state.submitting) return;
    // Starting invalidates any status read that was already in flight.
    const current = ++revision;
    state.submitting = true;
    state.error = "";
    state.refreshError = "";
    try {
      const result = await request<RuntimeResponse>("account/runtime/start", state.qqAccount.trim() ? { qqAccount: state.qqAccount.trim() } : {});
      if (!disposed && current === revision) state.runtime = result.runtime;
    } catch (cause) {
      if (!disposed && current === revision) state.error = failure(cause);
    } finally {
      if (!disposed) state.submitting = false;
    }
  }
  return {
    state,
    refresh,
    start,
    dispose: () => {
      disposed = true;
      ++revision;
    },
  };
}

function failure(cause: unknown) {
  return cause instanceof Error ? cause.message : "操作失败，请稍后重试。";
}
