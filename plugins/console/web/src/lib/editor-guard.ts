import { getCurrentInstance, onScopeDispose } from "vue";

import { confirmDialog } from "./dialog";
import { toast } from "./toast";

/** How long leaving a page waits for a save in flight. */
const SAVE_WAIT_MS = 10_000;

/** Whether `busy` turns false within `limit` ms. */
async function settled(busy: () => boolean, limit: number): Promise<boolean> {
  const end = Date.now() + limit;
  while (busy() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
  return !busy();
}

/** One confirmation for all editors mounted on a page, including nested permission editors. */
export function createEditorRegistry() {
  const editors = new Set<{ dirty(): boolean; busy(): boolean }>();
  let pending: Promise<boolean> | undefined;
  const changed = () => [...editors].some((editor) => editor.dirty());
  const busy = () => [...editors].some((editor) => editor.busy());
  return {
    changed,
    busy,
    register(dirty: () => boolean, working: () => boolean) {
      const editor = { dirty, busy: working };
      editors.add(editor);
      return () => {
        editors.delete(editor);
      };
    },
    async leave(
      confirm = () =>
        confirmDialog({
          title: "修改尚未保存",
          message: "未保存的修改还没有生效。是否离开当前页面？",
          confirmLabel: "离开页面",
          cancelLabel: "继续编辑",
          danger: true,
        }),
      wait = SAVE_WAIT_MS,
    ) {
      // A save that is still on its way (most pages save each change as it is made) is waited for, so the next page
      // reads it; only one that never finishes keeps the owner here.
      if (busy() && !(await settled(busy, wait))) {
        toast("保存还没完成，请稍后再切换页面。", "danger");
        return false;
      }
      if (!changed()) return true;
      pending ??= confirm().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}
export const editorRegistry = createEditorRegistry();

/** State factories can also run outside components in tests/services, without registering UI guards. */
export function trackEditor(dirty: () => boolean, busy: () => boolean) {
  if (!getCurrentInstance() || typeof window === "undefined") return;
  const unregister = editorRegistry.register(dirty, busy);
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!dirty() && !busy()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", beforeUnload);
  onScopeDispose(() => {
    unregister();
    window.removeEventListener("beforeunload", beforeUnload);
  });
}
