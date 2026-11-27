import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { JsonlUsageHistory } from "../src/jsonl.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("JsonlUsageHistory", () => {
  it("scans assistant usage and deduplicates entries across session files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yesimbot-usage-jsonl-"));
    temporaryDirectories.push(directory);
    const timestamp = Date.now();
    const message = (id: string) =>
      JSON.stringify({
        id: `entry-${id}`,
        type: "message",
        data: {
          id: `message-${id}`,
          timestamp,
          role: "assistant",
          usage: { inputTokens: 100, inputTokenDetails: { noCacheTokens: 40, cacheReadTokens: 60 }, outputTokens: 10, outputTokenDetails: {} },
        },
        timestamp,
      });

    await writeFile(join(directory, "a.jsonl"), `${message("a")}\n${message("b")}\n`);
    await writeFile(join(directory, "b.jsonl"), `${message("a")}\n`);

    const history = new JsonlUsageHistory(directory);
    const payload = await history.scan();

    expect(payload.recent).toHaveLength(31);
    expect(payload.recent[0].calls).toBe(2);
    expect(payload.recent[0].inputTokens).toBe(200);
    expect(payload.recent[0].outputTokens).toBe(20);
    expect(payload.byHour[new Date(timestamp).getHours()].calls).toBe(2);
  });
});

it("expires hourly JSONL results at local midnight without a file change", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 5, 23, 59));
  const directory = await mkdtemp(join(tmpdir(), "yesimbot-usage-midnight-"));
  temporaryDirectories.push(directory);
  await writeFile(
    join(directory, "session.jsonl"),
    JSON.stringify({
      type: "message",
      data: {
        id: "today",
        role: "assistant",
        timestamp: Date.now(),
        usage: { inputTokens: 100, outputTokens: 10 },
      },
    }),
  );
  const history = new JsonlUsageHistory(directory);
  expect((await history.scan()).byHour[23].inputTokens).toBe(100);
  vi.setSystemTime(new Date(2026, 10, 6, 0, 1));
  const next = await history.scan();
  expect(next.byHour.every((hour) => hour.inputTokens === 0 && hour.calls === 0)).toBe(true);
  expect(next.recent[0].calls).toBe(0);
  expect(next.recent[1].inputTokens).toBe(100);
});
