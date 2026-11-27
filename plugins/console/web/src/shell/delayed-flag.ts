import { getCurrentScope, onScopeDispose, ref, watch, type Ref } from "vue";

/** True once `source` has stayed true for `delay` ms; false as soon as it turns false. */
export function delayedFlag(source: () => boolean, delay: number): Ref<boolean> {
  const shown = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(
    source,
    (value) => {
      clearTimeout(timer);
      timer = undefined;
      if (!value) shown.value = false;
      else if (!shown.value) timer = setTimeout(() => (shown.value = true), delay);
    },
    { immediate: true, flush: "sync" },
  );
  if (getCurrentScope()) onScopeDispose(() => clearTimeout(timer));
  return shown;
}
