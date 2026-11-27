import type { UsageStore } from "./store.js";
import type { UsagePayload } from "./types.js";

/** Usage source the standalone WebUI reads (overview card and usage page), provided as `yesimbotUsage`. */
export class UsageService {
  private readonly listeners = new Set<() => void>();

  public constructor(private readonly store: UsageStore) {}

  public snapshot(): Promise<UsagePayload> {
    return this.store.snapshot();
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
