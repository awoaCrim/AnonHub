import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { contentHash, errorFields, readJson, writeFileAtomic } from "@yesimbot/foundation";

import { log } from "./log.js";

const CURSOR = /^(0|[1-9][0-9]{0,18})$/;

const STATE_FORMAT = {
  parse(value: unknown): ConsumerState {
    const state = value as Partial<Record<keyof ConsumerState, unknown>> | null;
    if (!state || typeof state !== "object" || typeof state.serverId !== "string" || typeof state.accountId !== "string")
      throw new TypeError("not a consumer state");
    return { serverId: state.serverId, accountId: state.accountId, ...(typeof state.cursor === "string" ? { cursor: state.cursor } : {}) };
  },
};

/**
 * Where this adapter has read the daemon's event log up to. The daemon offers no way to read a consumer's position
 * back, so it is kept here, per daemon (its server ID) and account: a reset daemon starts a new log.
 */
export interface ConsumerState {
  readonly serverId: string;
  readonly accountId: string;
  readonly cursor?: string;
}

export class ConsumerStateFile {
  private readonly file: string;
  private readonly directory: string;
  private writing: Promise<void> = Promise.resolve();
  public constructor(
    directory: string,
    private readonly serverId: string,
    private readonly accountId: string,
  ) {
    this.file = join(directory, `consumer-${contentHash(`${serverId}\0${accountId}`, { hexLength: 32 })}.json`);
    this.directory = directory;
  }

  public async load(): Promise<string | undefined> {
    try {
      const state = await readJson(this.file, STATE_FORMAT);
      if (state && state.serverId === this.serverId && state.accountId === this.accountId && state.cursor !== undefined && CURSOR.test(state.cursor))
        return state.cursor;
    } catch (error) {
      // An unreadable position starts at the end of the log, as no position does.
      log.warn("state.unreadable", { file: this.file, ...errorFields(error) });
    }
    return undefined;
  }

  /** Writes are serialized and atomic, so a crash keeps the previous position. */
  public save(cursor: string | undefined): Promise<void> {
    const state: ConsumerState = { serverId: this.serverId, accountId: this.accountId, ...(cursor ? { cursor } : {}) };
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeFileAtomic(this.file, JSON.stringify(state) + "\n", { mode: 0o600 });
      });
    return this.writing;
  }
}
