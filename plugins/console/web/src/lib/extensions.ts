import type { ExtensionItem } from "../../../src/shared/extensions";
import { ApiError } from "./api";

export const EXTENSIONS_ENDPOINT = "/yesimbot/api/v1/extensions";

/** The host's codes (`apps/server/src/installs.ts`) as the page says them. */
const messages: Record<string, string> = {
  extension_name_invalid: "请填写 npm 包名。",
  extension_version_invalid: "版本应为 1.2.3 这样的确定版本。",
  extension_installed: "这个扩展已经装了。",
  extension_install_busy: "另一个扩展正在安装，请等它装完。",
  extension_limit: "扩展数量已达上限，请先移除不用的。",
  extension_install_failed: "安装失败：npm 上没有这个包或这个版本，或者网络不通。",
  extension_not_extension: "这个包不是扩展。",
  extension_id_taken: "这个扩展和已有的模块重名了。",
  extension_not_found: "没有装这个扩展。",
};

/** Why an install did not go through, or what a failed action reports. */
export function extensionError(error: unknown): string {
  const code = error instanceof ApiError ? error.code : typeof error === "string" ? error : "";
  return messages[code] ?? "操作未能确认，请刷新后再试。";
}

/** `name` or `name@1.2.3`, as npm writes a package and its version; the version may be left out. */
export function packageSpec(input: string): { name: string; version: string } {
  const value = input.trim();
  const at = value.lastIndexOf("@");
  return at > 0 ? { name: value.slice(0, at), version: value.slice(at + 1) } : { name: value, version: "" };
}

export type { ExtensionItem };
