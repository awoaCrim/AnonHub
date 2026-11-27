import { afterEach, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref, type EffectScope } from "vue";

import type { AccountView } from "../src/shared/accounts";
import type { adminRequest } from "../web/src/lib/admin-request";
import { dismissToast, toast, toastErrors, toasts } from "../web/src/lib/toast";
import { createAccountsState } from "../web/src/state/accounts-state";

const scopes: EffectScope[] = [];
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop());
  toasts.splice(0);
  vi.useRealTimers();
});

function errors() {
  const error = ref(""),
    retrying = ref(false),
    inPage = ref(false);
  const scope = effectScope();
  scopes.push(scope);
  scope.run(() =>
    toastErrors(
      error,
      () => (error.value = ""),
      () => inPage.value,
      retrying,
    ),
  );
  return { error, retrying, inPage, scope };
}

it("returns the notification ID so an operation can dismiss its own message", () => {
  const id = toast("保存失败", "danger");
  expect(id).toBe(toasts[0]!.id);
  expect(toast("")).toBeUndefined();
  dismissToast(id!);
  expect(toasts).toEqual([]);
});

it("removes a failed action's toast as soon as its retry starts and leaves a later success visible", async () => {
  vi.useFakeTimers();
  const source = errors();
  source.error.value = "保存失败";
  await nextTick();
  expect(source.error.value).toBe("");
  expect(toasts.map((item) => item.text)).toEqual(["保存失败"]);
  source.retrying.value = true;
  expect(toasts).toEqual([]);
  source.retrying.value = false;
  toast("保存成功");
  await nextTick();
  expect(toasts.map((item) => item.text)).toEqual(["保存成功"]);
});

it("replaces repeated errors from the same source instead of stacking them", async () => {
  const source = errors();
  for (const message of ["保存失败", "保存失败", "配置已变化"]) {
    source.error.value = message;
    await nextTick();
    expect(source.error.value).toBe("");
    expect(toasts.map((item) => item.text)).toEqual([message]);
  }
});

it("keeps independently owned errors and ordinary notifications when one source retries or is disposed", async () => {
  const first = errors(),
    second = errors();
  first.error.value = "第一个操作失败";
  await nextTick();
  second.error.value = "第二个操作失败";
  await nextTick();
  const external = toast("其他页面的通知", "danger");
  first.retrying.value = true;
  expect(toasts.map((item) => item.text)).toEqual(["第二个操作失败", "其他页面的通知"]);
  first.scope.stop();
  expect(toasts).toHaveLength(2);
  second.scope.stop();
  expect(toasts.map((item) => item.id)).toEqual([external]);
  second.error.value = "卸载后的错误";
  await nextTick();
  expect(toasts.map((item) => item.id)).toEqual([external]);
});

it("keeps an unread page's error next to its retry action", async () => {
  const source = errors();
  source.inPage.value = true;
  source.error.value = "读取失败";
  await nextTick();
  expect(source.error.value).toBe("读取失败");
  expect(toasts).toEqual([]);
});

it("clears a failed friend creation's notification before retrying and showing the successful login share", async () => {
  const account = { id: "created", username: "friend" } as AccountView;
  const request = vi.fn().mockRejectedValueOnce(new Error("账号已存在")).mockResolvedValueOnce({ account });
  const view = createAccountsState(request as typeof adminRequest);
  view.state.accounts = [{ id: "existing", username: "existing" } as AccountView];
  view.state.username = "existing";
  view.state.password = "fixture-password";
  const scope = effectScope();
  scopes.push(scope);
  scope.run(() =>
    toastErrors(
      () => view.state.error,
      () => (view.state.error = ""),
      () => !view.state.accounts.length,
      () => view.state.busy,
    ),
  );
  try {
    await view.create();
    await nextTick();
    expect(toasts.map((item) => item.text)).toEqual(["账号已存在"]);
    view.state.username = "friend";
    view.state.password = "fixture-password";
    const retry = view.create();
    expect(toasts).toEqual([]);
    await retry;
    await nextTick();
    expect(view.state.share).toMatchObject({ username: "friend", reason: "created" });
    expect(toasts).toEqual([]);
  } finally {
    view.dispose();
  }
});
