/**
 * An extension this instance installed from npm, as 我的扩展 lists it (user, 2026-11-26: 「允许用户自己给自己的实例安装拓展」).
 * `module` is its module ID: its settings are that module's (`config/<module>.json`).
 */
export interface ExtensionItem {
  name: string;
  version?: string;
  module?: string;
  status: "installing" | "running" | "disabled" | "waiting" | "failed";
  /** A registered code: why it did not install, load or start. */
  error?: string;
}
