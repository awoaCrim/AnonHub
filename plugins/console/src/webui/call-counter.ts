import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { dayKey, writeFileAtomic, type Clock } from "@yesimbot/foundation";

import type { Host } from "../host.js";

/**
 * Today's model calls in this runtime, from Core's `yesimbot/model-usage` events. It works
 * without the optional usage plugin, so the owner sees every bot's activity. The count is
 * saved to a small file so a restart does not reset it.
 */
export class CallCounter {
  private day: string;
  private calls = 0;
  private dirty = false;

  public constructor(
    private readonly file: string,
    private readonly clock: Clock,
  ) {
    this.day = this.currentDay();
  }

  public async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8")) as { day?: unknown; calls?: unknown };
      if (saved.day === this.currentDay() && typeof saved.calls === "number" && Number.isFinite(saved.calls) && saved.calls >= 0) {
        this.day = saved.day;
        this.calls += saved.calls;
      }
    } catch {
      // Missing or unreadable: start from zero.
    }
  }

  public record(): void {
    this.roll();
    this.calls++;
    this.dirty = true;
  }

  public today(): number {
    this.roll();
    return this.calls;
  }

  public async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFileAtomic(this.file, JSON.stringify({ day: this.day, calls: this.calls }));
  }

  private currentDay(): string {
    return dayKey(this.clock.now(), this.clock);
  }

  private roll(): void {
    const day = this.currentDay();
    if (day === this.day) return;
    this.day = day;
    this.calls = 0;
    this.dirty = true;
  }
}

export function installCallCounter(ctx: Host, file: string): CallCounter {
  const counter = new CallCounter(file, ctx.clock);
  const loaded = counter.load();
  ctx.on("yesimbot/model-usage", () => void loaded.then(() => counter.record()));
  const save = () => void counter.save().catch(() => {});
  const timer = setInterval(save, 30_000);
  timer.unref?.();
  ctx.on("dispose", () => {
    clearInterval(timer);
    save();
  });
  return counter;
}
