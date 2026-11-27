import { expect, it, vi } from "vitest";
import { effectScope, reactive, ref } from "vue";

import { useTopic } from "../web/src/lib/use-topic";

const fixture = vi.hoisted(() => ({ use: vi.fn(), dispose: () => {} }));
vi.mock("../web/src/context", () => ({ useLive: () => ({ use: fixture.use }) }));
vi.mock("vue", async (original) => ({
  ...(await original<typeof import("vue")>()),
  onBeforeUnmount: (dispose: () => void) => {
    fixture.dispose = dispose;
  },
}));

it("starts and releases the optional topic when verified features replace a remembered bootstrap", () => {
  const enabled = ref(false);
  const release = vi.fn();
  const remote = reactive({ data: { calls: 1 }, revision: 1, stale: false, failed: false, cached: false, unavailable: false });
  fixture.use.mockReturnValue({ state: remote, release });
  const scope = effectScope();
  const state = scope.run(() => useTopic<{ calls: number }>("usage", () => enabled.value))!;
  expect(fixture.use).not.toHaveBeenCalled();
  expect(state.data).toBeUndefined();
  enabled.value = true;
  expect(fixture.use).toHaveBeenCalledOnce();
  expect(state.data).toEqual({ calls: 1 });
  remote.data.calls = 2;
  expect(state.data).toEqual({ calls: 2 });
  enabled.value = false;
  expect(release).toHaveBeenCalledOnce();
  expect(state.data).toBeUndefined();
  enabled.value = true;
  expect(fixture.use).toHaveBeenCalledTimes(2);
  fixture.dispose();
  scope.stop();
  expect(release).toHaveBeenCalledTimes(2);
});
