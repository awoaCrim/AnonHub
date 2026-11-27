import { nextTick, reactive, type InjectionKey, type Ref } from "vue";

/**
 * Inside the 设置 window, what used to open a dialog over it opens as a page of the window instead, under a
 * breadcrumb (user, 2026-11-23: 「设置弹窗里面最好还是用切换tab页面的方式，加个面包屑，那种配置页面最忌弹窗套弹窗了」).
 * The open subpages form a stack: the last one is shown, the ones under it (and the category page) stay mounted but
 * hidden, and the breadcrumb or Esc goes back one level or more.
 */
export const subpageHostKey: InjectionKey<SubpageHost> = Symbol("settings-subpages");

/** Provided by an open subpage to what is inside it (its save bar closes it). */
export const subpageKey: InjectionKey<{ close(): void }> = Symbol("settings-subpage");

export interface Subpage {
  readonly id: number;
  readonly title: () => string;
  /** Asks the subpage's owner to close it (its `update:open`); the owner may refuse, e.g. while saving. */
  readonly close: () => void;
}

export interface SubpageHost {
  /** Open subpages, outermost first. */
  readonly stack: readonly Subpage[];
  /** Where subpages render: the window's page area. */
  readonly target: Readonly<Ref<HTMLElement | undefined>>;
  open(title: () => string, close: () => void): number;
  remove(id: number): void;
  /** Closes the subpages above the first `depth` ones, innermost first: `0` goes back to the category page. */
  back(depth: number): void;
  /** Another category opened: whatever closes now returns to nothing (the new page starts at its top). */
  reset(): void;
}

/** A level as it was left when a subpage opened over it (level 0 is the category page): both come back with it. */
interface LeftLevel {
  readonly scrollTop: number;
  readonly focus?: HTMLElement;
}

/** The window's subpage stack. `scroller` is the window's scrolling page area, `target` where subpages render. */
export function createSubpageHost(scroller: Ref<HTMLElement | undefined>, target: Ref<HTMLElement | undefined>): SubpageHost {
  const stack = reactive<Subpage[]>([]) as Subpage[];
  let left: LeftLevel[] = [];
  let next = 0;
  let settling = false;
  /** After the shown subpage closes (with any under it, in one go): the level now shown returns as it was left. */
  function settle() {
    if (settling) return;
    settling = true;
    void nextTick(() => {
      settling = false;
      const level = left[stack.length];
      left = left.slice(0, stack.length);
      if (!level || !scroller.value) return;
      scroller.value.scrollTop = level.scrollTop;
      const back = level.focus?.isConnected && level.focus.getClientRects().length ? level.focus : scroller.value;
      back.focus({ preventScroll: true });
    });
  }
  return {
    stack,
    target,
    open(title, close) {
      const id = ++next;
      const active = typeof document === "undefined" ? undefined : ((document.activeElement as HTMLElement | null) ?? undefined);
      left[stack.length] = { scrollTop: scroller.value?.scrollTop ?? 0, focus: active };
      stack.push({ id, title, close });
      // A subpage starts at its top, with focus on it (not on its first control, which would show a focus ring).
      void nextTick(() => {
        if (stack.at(-1)?.id !== id || !scroller.value) return;
        scroller.value.scrollTop = 0;
        scroller.value.focus({ preventScroll: true });
      });
      return id;
    },
    remove(id) {
      const index = stack.findIndex((entry) => entry.id === id);
      if (index < 0) return;
      stack.splice(index, 1);
      if (index === stack.length) settle();
      // A level under the shown one went away (its owner closed first): the levels above it move down one.
      else left.splice(index + 1, 1);
    },
    back(depth) {
      for (const entry of stack.slice(depth).reverse()) entry.close();
    },
    reset() {
      left = [];
    },
  };
}
