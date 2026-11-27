import { describe, expect, it } from "vitest";

import { AppError, dayKey, formatForModel, manualClock, systemClock } from "../src/index.js";

const at = Date.UTC(2026, 10, 23, 6, 5, 30);

describe("time", () => {
  it("formats in the configured zone, whatever the process TZ is", () => {
    expect(formatForModel(at, manualClock(at))).toBe("2026-11-23 周一 14:05（UTC+8）");
    expect(formatForModel(at, manualClock(at, "UTC"))).toBe("2026-11-23 周一 06:05（UTC）");
    expect(formatForModel(at, manualClock(at, "America/New_York"))).toBe("2026-11-23 周一 01:05（UTC-5）");
    expect(formatForModel(at, manualClock(at, "Asia/Kolkata"))).toBe("2026-11-23 周一 11:35（UTC+5:30）");
    expect(formatForModel(Date.UTC(2026, 6, 1, 12), manualClock(0, "America/New_York"))).toBe("2026-07-01 周三 08:00（UTC-4）");
  });

  it("groups by the configured zone's calendar day", () => {
    const lateUtc = Date.UTC(2026, 10, 23, 17, 0);
    expect(dayKey(lateUtc, manualClock(0))).toBe("2026-11-24");
    expect(dayKey(lateUtc, manualClock(0, "UTC"))).toBe("2026-11-23");
    expect(formatForModel(Date.UTC(2026, 10, 23, 16, 0), manualClock(0))).toBe("2026-11-24 周二 00:00（UTC+8）");
  });

  it("refuses an unknown zone and moves a manual clock", () => {
    expect(() => systemClock("Mars/Base")).toThrow(AppError);
    const clock = manualClock(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
    clock.set(5);
    expect(clock.now()).toBe(5);
    expect(Math.abs(systemClock().now() - Date.now())).toBeLessThan(1000);
  });
});
