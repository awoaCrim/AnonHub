import type { ImageModel } from "ai";

import type { ModelId } from "./index.js";

export type ImageEditor = (options: ImageEditRequest) => Promise<ImageEditResponse>;

/** Images API models are declared separately from image-understanding chat models. */
export interface ImageModelConfig {
  id: string;
  name?: string;
  hidden?: boolean;
}

export interface ImageEditRequest {
  readonly sourceDataUrls: readonly string[];
  readonly prompt: string;
  readonly size?: string;
  readonly abortSignal: AbortSignal;
  /** The requesting channel's output limit, applied before parsing the provider response. */
  readonly maxBytes: number;
}

export interface ImageEditResponse {
  readonly images: readonly { readonly uint8Array: Uint8Array }[];
  readonly totalImages?: number;
}

/** Connection-owned generation and JSON Images edits transports, without connection secrets. */
export interface ImageModelAdapter {
  readonly model: ImageModel;
  readonly edit: ImageEditor;
}

export interface ImageModelRef extends ImageModelAdapter {
  readonly fullId: ModelId;
  readonly providerId: string;
  readonly modelId: string;
  readonly entry: ImageModelConfig;
}
