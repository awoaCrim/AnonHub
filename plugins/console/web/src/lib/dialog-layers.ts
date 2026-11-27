import { defineComponent, inject, onMounted, onUnmounted, provide, ref, type InjectionKey } from "vue";

const dialogLayers: InjectionKey<(change: number) => void> = Symbol("dialog-layers");

/** A responsive parent must not remount its modal wrapper above an open child. */
export function provideDialogLayers() {
  const count = ref(0);
  provide(dialogLayers, (change) => (count.value += change));
  return count;
}

/** Lives inside the portal, so exit animations finish before the layer is released. */
export const DialogLayer = defineComponent({
  name: "DialogLayer",
  setup() {
    const change = inject(dialogLayers, undefined);
    onMounted(() => change?.(1));
    onUnmounted(() => change?.(-1));
    return () => null;
  },
});
