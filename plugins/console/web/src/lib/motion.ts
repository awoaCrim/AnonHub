import type { ObjectDirective } from "vue";

/** Animate a local tab change without remounting its editor or delaying data/rendering. */
export const vMotion: ObjectDirective<HTMLElement, unknown> = {
  updated(element, binding) {
    if (binding.value === binding.oldValue || typeof element.animate !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const animation of element.getAnimations()) animation.cancel();
    element.animate(
      [
        { opacity: 0.65, transform: "translateY(4px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 160, easing: "ease-out" },
    );
  },
};
