import { EphemeralProjectionRegistry } from "./ephemeral-projection.js";

export interface EphemeralImageProjection {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  /** Opaque live result owner; never serialized into model output or durable receipts. */
  readonly owner?: object;
}

/** Effective transport to the executing model. Description through another model is not native. */
export interface NativeImageInputPolicy {
  readonly mode: "native" | "unavailable";
  readonly nativeMediaTypes?: readonly string[];
}

export interface EphemeralImageProjectionStage extends EphemeralImageProjection {
  readonly toolCallId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
}

/**
 * Multi-frame variant for tools whose evidence is a bounded sample rather than one image, for
 * example a GIF preview. Frames share one call id, one TTL and one cleanup boundary.
 */
export interface EphemeralImageFramesStage {
  readonly toolCallId: string;
  readonly turnId: string;
  readonly frames: readonly EphemeralImageProjection[];
  readonly signal?: AbortSignal;
}

export interface EphemeralImageProjectionStoreOptions {
  readonly ttlMs?: number;
  readonly capacity?: number;
}

/**
 * Keeps image bytes available only for the bounded live-turn projection window. Durable message
 * sanitization remains a separate storage-boundary concern. This is a typed facade over the
 * shared payload-agnostic registry, so its public single-frame/multi-frame behavior is unchanged.
 */
export class EphemeralImageProjectionStore {
  private readonly registry: EphemeralProjectionRegistry<readonly EphemeralImageProjection[]>;

  public constructor(options: EphemeralImageProjectionStoreOptions = {}) {
    this.registry = new EphemeralProjectionRegistry<readonly EphemeralImageProjection[]>({
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
      normalize: (frames) => {
        const value = frames.filter((frame) => frame.bytes instanceof Uint8Array && frame.bytes.byteLength > 0);
        return value.length > 0 ? value : undefined;
      },
    });
  }

  public stage(input: EphemeralImageProjectionStage): boolean {
    return this.stageFrames({
      toolCallId: input.toolCallId,
      turnId: input.turnId,
      frames: [{ bytes: input.bytes, mediaType: input.mediaType, ...(input.owner === undefined ? {} : { owner: input.owner }) }],
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  /** Stages a bounded frame set under one call id; an aborted signal releases any previous set. */
  public stageFrames(input: EphemeralImageFramesStage): boolean {
    return this.registry.set({
      toolCallId: input.toolCallId,
      turnId: input.turnId,
      value: input.frames.map((frame) => ({ bytes: frame.bytes, mediaType: frame.mediaType, ...(frame.owner === undefined ? {} : { owner: frame.owner }) })),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  public get(toolCallId: string): EphemeralImageProjection | undefined {
    return this.getFrames(toolCallId)[0];
  }

  /** Returns every staged frame for the call id, refreshing only the shared sliding TTL. */
  public getFrames(toolCallId: string): readonly EphemeralImageProjection[] {
    return this.registry.get(toolCallId) ?? [];
  }

  /** True while the call id still owns a live projection; used to reject evidence after abort. */
  public has(toolCallId: string): boolean {
    return this.registry.has(toolCallId);
  }

  public clear(toolCallId: string): void {
    this.registry.clear(toolCallId);
  }

  public clearTurn(turnId: string): void {
    this.registry.clearTurn(turnId);
  }

  public clearAll(): void {
    this.registry.clearAll();
  }
}
