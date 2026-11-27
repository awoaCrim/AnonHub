import { EphemeralImageProjectionStore, EphemeralVideoProjectionStore, type AgentPlugin } from "@yesimbot/agent-runtime";

import type { InputImageResolution } from "../messages/index.js";
import type { ImageFailureCode } from "../resources/image-failure.js";
import { resourceErrorCode, type ChannelResources } from "../resources/index.js";

/** Per-runtime media the model reads once and the runtime then drops: image/video projections and the native-video budget. */
export class MediaProjections {
  public readonly images: EphemeralImageProjectionStore;
  /** Turn ids that already received one successful native video payload. */
  private readonly videoReadTurns = new Set<string>();

  public constructor(
    images: EphemeralImageProjectionStore | undefined,
    public readonly videos: EphemeralVideoProjectionStore | undefined,
    private readonly resources: ChannelResources,
    /** Whether `turnId` is the turn the runtime is currently running. */
    private readonly turnIsLive: (turnId: string) => boolean,
  ) {
    this.images = images ?? new EphemeralImageProjectionStore();
  }

  /**
   * Synchronous per-turn reservation for the one native video payload. It is independent of the
   * projection TTL and of call-id reuse, so a repeated or retried call cannot reset the budget.
   * Failed admissions never reserve, and a later turn may read a retained asset afresh.
   */
  public reserveVideoRead(turnId: string): boolean {
    if (!this.turnIsLive(turnId) || this.videoReadTurns.has(turnId)) return false;
    this.videoReadTurns.add(turnId);
    return true;
  }

  public releaseVideoRead(turnId: string): void {
    this.videoReadTurns.delete(turnId);
  }

  public clearVideos(): void {
    this.videos?.clearAll();
    this.videoReadTurns.clear();
  }

  public clearAll(): void {
    this.images.clearAll();
    this.clearVideos();
  }

  public async resolveInputImage(assetId: string, signal?: AbortSignal): Promise<InputImageResolution> {
    try {
      const opened = await this.resources.openStrict(`asset://${assetId}`, signal);
      const mediaType = this.resources.detectImageMediaType(opened.bytes);
      return mediaType ? { bytes: opened.bytes, mediaType } : { error: "not_image" };
    } catch (cause) {
      const code = resourceErrorCode(cause);
      if (!code) return { error: "resource_unavailable" };
      const error: ImageFailureCode =
        code === "resource_not_found"
          ? "resource_missing"
          : code === "resource_timeout"
            ? "timeout"
            : code === "resource_too_large"
              ? "too_large"
              : code === "resource_read_aborted"
                ? "resource_aborted"
                : code === "resource_unavailable"
                  ? "resource_unavailable"
                  : "download_failed";
      return { error };
    }
  }

  public plugin(): AgentPlugin {
    return {
      name: "core.image-projection",
      onTurnFinish: (_result, context) => {
        this.images.clearTurn(context.turnId);
        this.videos?.clearTurn(context.turnId);
        this.videoReadTurns.delete(context.turnId);
      },
      stop: () => this.clearAll(),
    };
  }
}
