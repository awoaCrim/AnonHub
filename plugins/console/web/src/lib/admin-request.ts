import { notifyUnauthorized } from "./api";
import { cachedFetch } from "./cache";

/** Same contract as the legacy console helpers, so the ported state modules stay unchanged. */
export async function protectedAdminFetch(input: RequestInfo | URL, init?: RequestInit, fresh = false): Promise<Response> {
  const response = await cachedFetch((...args) => fetch(...args), input, init, fresh);
  if (response.status === 401) notifyUnauthorized(String(input));
  return response;
}

/** `fresh` bypasses the cached copy of an allow-listed read, for callers that poll for changes. */
export async function adminRequest<T>(path: string, body?: object, options: { fresh?: boolean } = {}): Promise<T> {
  const response = await protectedAdminFetch(
    `/yesimbot/${path}`,
    {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    },
    options.fresh,
  );
  if (!response.ok) {
    if (response.status === 401) throw new Error("登录已失效，请重新登录。");
    if (response.status === 403) throw new Error("没有操作权限，或访问来源校验失败，请重新登录后重试。");
    if (response.status === 429) {
      const value = response.headers?.get("Retry-After") ?? "";
      const seconds = /^\d+$/.test(value) ? Number(value) : NaN;
      throw new Error(`操作过多，请等待 ${Number.isInteger(seconds) && seconds >= 1 && seconds <= 60 ? seconds : 60} 秒后重试。`);
    }
    if (response.status === 409) throw new Error("账户名称或 QQ 号码已被使用，或当前状态发生变化，请刷新后重试。");
    if (response.status === 400) throw new Error("请检查账户名称、密码和 QQ 号码是否符合要求。");
    throw new Error("请求失败，请稍后重试。");
  }
  return response.json();
}
