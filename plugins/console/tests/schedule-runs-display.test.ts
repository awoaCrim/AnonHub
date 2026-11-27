import { expect, it } from "vitest";

import type { ScheduleRun } from "../src/shared/schedules";
import { formatScheduleTime, runDescription, runDuration, runLabel } from "../web/src/lib/schedule-runs";

const run: ScheduleRun = {
  id: "run",
  scheduleId: "plan",
  occurrenceAt: "2026-11-14T01:00:00Z",
  recordedAt: "2026-11-14T01:00:00Z",
  status: "completed",
  purpose: "task",
  delivery: "channel",
};

it("distinguishes a completed turn, delivery and heartbeat silence without claiming external success", () => {
  expect(runLabel(run)).toBe("已结束");
  expect(runDescription(run)).toContain("具体任务结果");
  expect(runLabel({ ...run, purpose: "heartbeat", notified: false })).toBe("无需通知");
  expect(runLabel({ ...run, purpose: "heartbeat", notified: true })).toBe("已通知");
  expect(runLabel({ ...run, purpose: "heartbeat" })).toBe("已结束");
  expect(runLabel({ ...run, status: "accepted" })).toBe("结果未知");
  expect(runDescription({ ...run, status: "missed" })).toBe("本次计划没有执行。");
  expect(runDescription({ ...run, status: "undelivered" })).toContain("没有向所属会话发送回复");
});

it("uses actual start/end for duration and never converts queue time or unknown data to zero", () => {
  expect(runDuration({ ...run, queuedAt: run.occurrenceAt, finishedAt: "2026-11-14T01:03:00Z" })).toBe("—");
  expect(runDuration({ ...run, startedAt: "2026-11-14T01:02:00Z", finishedAt: "2026-11-14T01:03:05Z" })).toBe("1 分 5 秒");
  expect(
    runDuration({
      ...run,
      startedAt: "2026-11-14T01:02:00Z",
      finishedAt: "2026-11-14T02:00:00Z",
      status: "interrupted",
      error: { code: "process_interrupted", message: "服务重启" },
    }),
  ).toBe("—");
  expect(runDuration({ ...run, startedAt: "bad", finishedAt: "bad" })).toBe("—");
  expect(runDuration({ ...run, startedAt: "2026-11-14T01:02:00Z", finishedAt: "2026-11-14T01:01:00Z" })).toBe("—");
  expect(formatScheduleTime(run.occurrenceAt, true)).toBe("2026/11/14 09:00:00");
});
