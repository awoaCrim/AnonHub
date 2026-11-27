import { afterEach, expect, it, vi } from "vitest";

import type { ScheduleRun, ScheduleRunsSnapshot } from "../src/shared/schedules";
import { api, ApiError } from "../web/src/lib/api";
import { createScheduleRunHistory } from "../web/src/state/schedule-runs";

vi.mock("../web/src/lib/api", async (original) => ({ ...(await original<typeof import("../web/src/lib/api")>()), api: vi.fn() }));
const mockedApi = vi.mocked(api);
const row = (id: string): ScheduleRun => ({
  id,
  scheduleId: "plan",
  occurrenceAt: "2026-11-14T01:00:00Z",
  recordedAt: "2026-11-14T01:00:01Z",
  status: "completed",
  purpose: "task",
  delivery: "channel",
});
const page = (runs: ScheduleRun[], nextCursor: string | null = null): ScheduleRunsSnapshot => ({ runs, nextCursor, retainedLimit: 100 });
const histories: ReturnType<typeof createScheduleRunHistory>[] = [];
function history() {
  const value = createScheduleRunHistory();
  histories.push(value);
  return value;
}
afterEach(() => {
  histories.splice(0).forEach((value) => value.dispose());
  vi.resetAllMocks();
});

it("reads a plan lazily and paginates without writes or duplicate records", async () => {
  const h = history();
  expect(mockedApi).not.toHaveBeenCalled();
  mockedApi.mockResolvedValueOnce(page([row("new")], "opaque+/="));
  await h.open("plan/a");
  expect(mockedApi).toHaveBeenLastCalledWith(
    "/yesimbot/api/v1/schedules/plan%2Fa/runs",
    undefined,
    expect.objectContaining({ fresh: true, signal: expect.any(AbortSignal) }),
  );
  mockedApi.mockResolvedValueOnce(page([row("new"), row("old")]));
  await h.more();
  expect(mockedApi.mock.lastCall?.[0]).toBe("/yesimbot/api/v1/schedules/plan%2Fa/runs?before=opaque%2B%2F%3D");
  expect(h.state.runs.map((run) => run.id)).toEqual(["new", "old"]);
  expect(h.state.nextCursor).toBeNull();
  await h.more();
  expect(mockedApi).toHaveBeenCalledTimes(2);
});

it("keeps loaded records when paging fails and retries the same page", async () => {
  const h = history();
  mockedApi.mockResolvedValueOnce(page([row("new")], "older"));
  await h.open("plan");
  mockedApi.mockRejectedValueOnce(new Error("private provider credential must not appear"));
  await h.more();
  expect(h.state.runs.map((run) => run.id)).toEqual(["new"]);
  expect(h.state.error).toBe("暂时无法读取执行记录，请重试。");
  expect(h.state.failedMore).toBe(true);
  mockedApi.mockResolvedValueOnce(page([row("old")]));
  await h.retry();
  expect(h.state.runs.map((run) => run.id)).toEqual(["new", "old"]);
  expect(h.state.error).toBe("");
});

it("ignores a late page from another plan and aborts reads on close", async () => {
  const h = history();
  let resolve!: (value: ScheduleRunsSnapshot) => void;
  mockedApi.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = h.open("a");
  const signal = mockedApi.mock.lastCall?.[2]?.signal;
  mockedApi.mockResolvedValueOnce(page([row("b")]));
  await h.open("b");
  expect(signal?.aborted).toBe(true);
  resolve(page([row("a")]));
  await pending;
  expect(h.state.runs.map((run) => run.id)).toEqual(["b"]);
  mockedApi.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const late = h.refresh();
  const lastSignal = mockedApi.mock.lastCall?.[2]?.signal;
  h.dispose();
  resolve(page([row("late")]));
  await late;
  expect(lastSignal?.aborted).toBe(true);
  expect(h.state.runs.map((run) => run.id)).toEqual(["b"]);
});

it("preserves unknown/error states and replaces old pages on an explicit refresh", async () => {
  const h = history();
  mockedApi.mockRejectedValueOnce(new ApiError(404, "not_found"));
  await h.open("removed");
  expect(h.state.error).toBe("计划已删除或不可访问。");
  expect(h.state.loaded).toBe(false);
  mockedApi.mockResolvedValueOnce(page([row("first")], "cursor"));
  await h.open("plan");
  mockedApi.mockResolvedValueOnce(page([row("second")]));
  await h.more();
  mockedApi.mockResolvedValueOnce(page([{ ...row("latest"), status: "running" }]));
  await h.refresh();
  expect(h.state.runs.map((run) => run.id)).toEqual(["latest"]);
  expect(h.state.pages).toBe(1);
});
