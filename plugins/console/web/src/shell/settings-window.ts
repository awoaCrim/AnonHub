import { defineComponent, provide, reactive, ref, type InjectionKey, type PropType } from "vue";
import { routeLocationKey, START_LOCATION, type RouteLocationNormalized, type RouteLocationNormalizedLoaded } from "vue-router";

/**
 * 设置 is a window over the page the user was on (user, 2026-11-22: 「整个设置页面也做成弹窗」). Its routes stay
 * /settings/*; the page under it is the last page outside 设置, or home when 设置 was opened directly.
 */
export const settingsBackground = ref("/");

/** The page under the window before the latest navigation (scrolling runs after the navigation is recorded). */
let previousBackground = "/";

/** Called after every navigation: remembers the page the 设置 window opens over. */
export function rememberBackground(to: RouteLocationNormalized) {
  previousBackground = settingsBackground.value;
  if (to.meta.public) settingsBackground.value = "/";
  else if (!to.meta.settings && to.meta.shell !== false && to.matched.length) settingsBackground.value = to.fullPath;
}

/** Opening the window, moving inside it, or closing it back onto its page: the page under it keeps its scroll position. */
export function keepsPageScroll(to: RouteLocationNormalized, from: RouteLocationNormalized) {
  return !!to.meta.settings || (!!from.meta.settings && to.fullPath === previousBackground);
}

/**
 * Makes `useRoute()` below it answer with `route`: the page under the window keeps seeing its own route (its query,
 * its params) while the address shows the window's, and the window's pages see the real one again.
 */
export const RouteScope = defineComponent({
  name: "RouteScope",
  props: { route: { type: Object as PropType<RouteLocationNormalizedLoaded>, required: true } },
  setup(props, { slots }) {
    const scoped = {} as RouteLocationNormalizedLoaded;
    for (const key of Object.keys(START_LOCATION) as (keyof RouteLocationNormalizedLoaded)[])
      Object.defineProperty(scoped, key, { get: () => props.route[key], enumerable: true });
    provide(routeLocationKey, reactive(scoped));
    return () => slots.default?.();
  },
});
