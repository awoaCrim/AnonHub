import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { manualClock } from "@yesimbot/foundation";
import { expect, it } from "vitest";

import { CallCounter } from "../src/webui/call-counter";

const at = (month: number, day: number, hour: number, minute = 0) => Date.UTC(2026, month - 1, day, hour - 8, minute);

it("counts today's calls, survives a restart and starts over the next day", async () => {
  const clock = manualClock(at(11, 1, 23));
  const file = join(mkdtempSync(join(tmpdir(), "calls-")), "today-calls.json");
  const first = new CallCounter(file, clock);
  await first.load();
  first.record();
  first.record();
  await first.save();
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ day: "2026-11-01", calls: 2 });

  const restarted = new CallCounter(file, clock);
  await restarted.load();
  restarted.record();
  expect(restarted.today()).toBe(3);

  clock.set(at(11, 2, 0, 1));
  expect(restarted.today()).toBe(0);
});

it("ignores a saved count from another day or a damaged file", async () => {
  const clock = manualClock(at(11, 2, 9));
  const file = join(mkdtempSync(join(tmpdir(), "calls-")), "today-calls.json");
  writeFileSync(file, JSON.stringify({ day: "2026-11-01", calls: 50 }));
  const old = new CallCounter(file, clock);
  await old.load();
  expect(old.today()).toBe(0);
  writeFileSync(file, "{not json");
  const damaged = new CallCounter(file, clock);
  await damaged.load();
  expect(damaged.today()).toBe(0);
});
