import { shallowRef } from "vue";

export interface ConfirmOptions {
  readonly title: string;
  readonly message?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** Red confirm button for destructive or disruptive actions. */
  readonly danger?: boolean;
  /** For what cannot be undone: the confirm button waits until exactly this is typed. */
  readonly typeToConfirm?: string;
}
interface PendingConfirm extends ConfirmOptions {
  readonly resolve: (ok: boolean) => void;
}

export const pendingConfirm = shallowRef<PendingConfirm>();

/** In-app replacement for window.confirm; resolves false when dismissed. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  pendingConfirm.value?.resolve(false);
  return new Promise((resolve) => {
    pendingConfirm.value = { ...options, resolve };
  });
}

export function settleConfirm(ok: boolean): void {
  const pending = pendingConfirm.value;
  pendingConfirm.value = undefined;
  pending?.resolve(ok);
}
