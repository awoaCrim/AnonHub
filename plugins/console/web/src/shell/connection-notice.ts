import type { InjectionKey } from "vue";

/**
 * Provided by AppShell, which shows the one disconnect notice for the whole page.
 * Topic feedback inside it does not repeat that notice per data block.
 */
export const connectionNoticeKey: InjectionKey<boolean> = Symbol("connection-notice");
