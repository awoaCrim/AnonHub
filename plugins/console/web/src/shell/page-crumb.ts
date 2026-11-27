import { onActivated, onBeforeUnmount, onDeactivated, shallowRef, watchEffect, type WatchStopHandle } from "vue";

/**
 * A list page showing one of its items: the page title becomes 「实例 › sunshen」, and the first part goes
 * back to the list. There is no separate back button.
 */
export interface PageCrumb {
  readonly label: string;
  readonly back: () => void;
}
export const pageCrumb = shallowRef<PageCrumb>();

/** While the calling page is shown, its title follows `get` (undefined = the plain page title). */
export function usePageCrumb(get: () => PageCrumb | undefined): void {
  let stop: WatchStopHandle | undefined;
  const start = () => {
    stop?.();
    stop = watchEffect(() => (pageCrumb.value = get()));
  };
  const end = () => {
    stop?.();
    stop = undefined;
    pageCrumb.value = undefined;
  };
  start();
  onActivated(start);
  onDeactivated(end);
  onBeforeUnmount(end);
}
