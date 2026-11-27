import { getCurrentScope, onScopeDispose, reactive, watch, type WatchSource } from "vue";

export interface Toast {
  readonly id: number;
  readonly text: string;
  readonly tone: "ok" | "warn" | "danger";
  readonly duration: number;
  /** One follow-up, e.g. 撤销 after a setting saved on change. */
  readonly action?: ToastAction;
}

export interface ToastAction {
  readonly label: string;
  readonly run: () => void;
}

/** Short confirmations shown in a corner instead of inside the page layout. */
export const toasts = reactive<Toast[]>([]);
let next = 0;
const durations: Record<Toast["tone"], number> = { ok: 4000, warn: 8000, danger: 8000 };

export function toast(text: string, tone: Toast["tone"] = "ok", ms = durations[tone], action?: ToastAction): number | undefined {
  if (!text) return;
  const id = ++next;
  toasts.push({ id, text, tone, duration: action ? Math.max(ms, 6000) : ms, ...(action ? { action } : {}) });
  if (toasts.length > 3) toasts.shift();
  return id;
}

export function dismissToast(id: number): void {
  const index = toasts.findIndex((item) => item.id === id);
  if (index >= 0) toasts.splice(index, 1);
}

/** Moves a page's success notice into a toast and clears it from the page. */
export function toastNotices(source: WatchSource<string | undefined>, clear: () => void): void {
  watch(source, (text) => {
    if (!text) return;
    toast(text);
    clear();
  });
}

/**
 * Action errors (a failed save) become toasts while the page is usable; errors while nothing is
 * loaded stay in the page, next to their retry button. Each source owns one toast until its next
 * attempt (`retrying`) or disposal; other operations' notices are left alone. An editor that rereads
 * the server copy after a failed save must not count that reread as an attempt, or the toast closes
 * as it opens: pass its save state, not its loading state.
 */
export function toastErrors(source: WatchSource<string | undefined>, clear: () => void, inPage: () => boolean, retrying?: WatchSource<boolean>): void {
  let current: number | undefined;
  const dismiss = () => {
    if (current !== undefined) dismissToast(current);
    current = undefined;
  };
  watch(source, (text) => {
    if (!text || inPage()) return;
    dismiss();
    current = toast(text, "danger");
    clear();
  });
  if (retrying)
    watch(
      retrying,
      (working) => {
        if (working) dismiss();
      },
      { flush: "sync" },
    );
  if (getCurrentScope()) onScopeDispose(dismiss);
}
