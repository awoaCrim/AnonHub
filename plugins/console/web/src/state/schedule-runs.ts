import { reactive } from "vue";

import type { ScheduleRun, ScheduleRunsSnapshot } from "../../../src/shared/schedules";
import { api, ApiError } from "../lib/api";

export function createScheduleRunHistory() {
  const state = reactive({
    runs: [] as ScheduleRun[],
    nextCursor: null as string | null,
    retainedLimit: 0,
    loaded: false,
    loading: false,
    loadingMore: false,
    error: "",
    failedMore: false,
    pages: 0,
  });
  let scheduleId = "",
    generation = 0,
    disposed = false;
  let controller: AbortController | undefined;

  async function read(append: boolean) {
    if (disposed || !scheduleId || (append && (state.loading || !state.nextCursor))) return;
    controller?.abort();
    const request = (controller = new AbortController());
    const token = ++generation;
    const cursor = append ? state.nextCursor : null;
    state.loading = true;
    state.loadingMore = append;
    state.error = "";
    state.failedMore = false;
    try {
      const page = await api<ScheduleRunsSnapshot>(
        `/yesimbot/api/v1/schedules/${encodeURIComponent(scheduleId)}/runs${cursor ? `?before=${encodeURIComponent(cursor)}` : ""}`,
        undefined,
        { fresh: true, signal: request.signal },
      );
      if (disposed || token !== generation) return;
      const rows = new Map((append ? state.runs : []).map((run) => [run.id, run]));
      for (const run of page.runs) rows.set(run.id, run);
      state.runs = [...rows.values()];
      state.nextCursor = page.nextCursor;
      state.retainedLimit = page.retainedLimit;
      state.loaded = true;
      state.pages = append ? state.pages + 1 : 1;
    } catch (cause) {
      if (disposed || token !== generation) return;
      state.failedMore = append && !(cause instanceof ApiError && cause.status === 400);
      state.error =
        cause instanceof ApiError && cause.status === 404
          ? "计划已删除或不可访问。"
          : cause instanceof ApiError && cause.status === 400
            ? "记录已更新，请刷新后查看。"
            : "暂时无法读取执行记录，请重试。";
    } finally {
      if (!disposed && token === generation) {
        state.loading = false;
        state.loadingMore = false;
      }
    }
  }

  function open(id: string) {
    controller?.abort();
    generation++;
    scheduleId = id;
    Object.assign(state, {
      runs: [],
      nextCursor: null,
      retainedLimit: 0,
      loaded: false,
      loading: false,
      loadingMore: false,
      error: "",
      failedMore: false,
      pages: 0,
    });
    return read(false);
  }
  function dispose() {
    disposed = true;
    generation++;
    controller?.abort();
  }
  return { state, open, refresh: () => read(false), more: () => read(true), retry: () => read(state.failedMore), dispose };
}
