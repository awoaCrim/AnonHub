import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { AppError, contentHash, writeFileAtomic } from "@yesimbot/foundation";

import { RESOURCE_ERRORS, resourceError } from "./errors.js";

const COMPLETE_ID = /^[a-f0-9]{32}$/;
const PREFIX_ID = /^[a-f0-9]{7,31}$/;

/** Additive bounded-read options; one-argument consumers keep the original unbounded behavior. */
export interface AssetReadOptions {
  /** Checked before allocation and again against the observed byte length. */
  readonly maxBytes?: number;
  /** Lets the owning resource layer cancel a pending read. */
  readonly signal?: AbortSignal;
}

export interface AssetStore {
  put(data: Uint8Array): Promise<string>;
  get(idOrPrefix: string, options?: AssetReadOptions): Promise<Uint8Array>;
  clear(): Promise<void>;
}

export class ChannelAssetStore implements AssetStore {
  public constructor(private readonly root: string) {}

  public async put(data: Uint8Array): Promise<string> {
    if (!(data instanceof Uint8Array)) throw new AppError(RESOURCE_ERRORS.asset_data_invalid, { effect: "none" });
    const copied = data.slice();
    const id = contentHash(copied, { hexLength: 32 });
    const path = this.path(id);
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, copied);
    return id;
  }

  /** Optional bounds are checked before allocation and again against the observed length. */
  public async get(idOrPrefix: string, options: AssetReadOptions = {}): Promise<Uint8Array> {
    options.signal?.throwIfAborted();
    let id = idOrPrefix;
    if (!COMPLETE_ID.test(id)) {
      if (!PREFIX_ID.test(idOrPrefix)) throw new AppError(RESOURCE_ERRORS.asset_id_invalid, { effect: "none" });
      let candidates: string[];
      try {
        candidates = (await readdir(this.path())).filter((name) => COMPLETE_ID.test(name) && name.startsWith(idOrPrefix));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") candidates = [];
        else throw cause;
      }
      if (candidates.length === 0) throw resourceError(RESOURCE_ERRORS.resource_not_found);
      if (candidates.length > 1) throw new AppError(RESOURCE_ERRORS.asset_prefix_ambiguous, { effect: "none" });
      id = candidates[0]!;
    }
    const path = this.path(id);
    if (options.maxBytes !== undefined) {
      const entry = await stat(path);
      if (entry.size > options.maxBytes) throw resourceError(RESOURCE_ERRORS.resource_too_large);
    }
    options.signal?.throwIfAborted();
    const data = new Uint8Array(await readFile(path, options.signal ? { signal: options.signal } : undefined));
    options.signal?.throwIfAborted();
    if (options.maxBytes !== undefined && data.byteLength > options.maxBytes) throw resourceError(RESOURCE_ERRORS.resource_too_large);
    return data;
  }

  public async clear(): Promise<void> {
    await rm(this.path(), { recursive: true, force: true });
  }

  private path(id?: string): string {
    const directory = join(this.root, "assets");
    return id === undefined ? directory : join(directory, id);
  }
}
