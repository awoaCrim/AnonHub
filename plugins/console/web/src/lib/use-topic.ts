import { onBeforeUnmount, shallowRef, watch } from "vue";

import { useLive } from "../context";
import type { TopicState } from "./live";

/** Subscribes for the lifetime of the calling component. */
export function useTopic<T>(name: string, enabled = () => true): TopicState<T> {
  const live = useLive();
  const current = shallowRef<TopicState<T>>();
  const stop = watch(
    enabled,
    (on, _, cleanup) => {
      current.value = undefined;
      if (!on) return;
      const subscription = live.use<T>(name);
      current.value = subscription.state;
      cleanup(subscription.release);
    },
    { immediate: true, flush: "sync" },
  );
  onBeforeUnmount(stop);
  return {
    get data() {
      return current.value?.data;
    },
    get revision() {
      return current.value?.revision ?? 0;
    },
    get stale() {
      return current.value?.stale ?? false;
    },
    get cached() {
      return current.value?.cached ?? false;
    },
    get failed() {
      return current.value?.failed ?? false;
    },
    get unavailable() {
      return current.value?.unavailable ?? false;
    },
  };
}
