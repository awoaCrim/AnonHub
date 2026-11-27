import { createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import { AppError, newSecret, readPrivateFile, writeFileAtomic } from "@yesimbot/foundation";
import { z } from "zod/v4";

import { googleError } from "./errors.js";

const accountSchema = z
  .object({
    id: z.string().uuid(),
    subject: z.string().min(1).max(256),
    email: z.string().email().max(320),
    name: z.string().max(200).optional(),
    client: z.string().length(64),
    refreshToken: z.string().min(1).max(16384),
    accessToken: z.string().max(16384).optional(),
    expiresAt: z.number().finite(),
    scopes: z.array(z.string().max(256)).max(30),
    connectedAt: z.number().finite(),
    needsReconnect: z.boolean(),
    permissions: z
      .object({ gmail: z.enum(["read", "manage"]).optional(), calendar: z.enum(["read", "manage"]).optional(), drive: z.enum(["read", "manage"]).optional() })
      .strict(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    tenant: z.string().min(1),
    accounts: z.array(accountSchema).max(8),
    attempts: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.number().finite()).refine((rows) => Object.keys(rows).length <= 5000),
  })
  .strict();
export type GoogleAccount = z.infer<typeof accountSchema>;

type State = z.infer<typeof stateSchema>;

/** One store per runtime. Only encrypted tokens reach disk; the private key is kept in its own 0600 file. */
export class GoogleStore {
  private tail = Promise.resolve();
  private constructor(
    private readonly dir: string,
    private readonly key: Buffer,
    private state: State,
  ) {}

  static async open(dir: string, tenant: string): Promise<GoogleStore> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const keyPath = join(dir, "key");
    try {
      const file = await open(keyPath, "wx", 0o600);
      try {
        await file.writeFile(Buffer.from(newSecret(32), "base64url"));
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Refuse symlink substitutions and a key others can read.
    const key = await readVault(keyPath, 32, true);
    if (key.length !== 32) throw googleError("google_store_invalid", { detail: "key length" });
    let state: State = { version: 1, tenant, accounts: [], attempts: {} };
    let bytes: Buffer | undefined;
    try {
      bytes = await readVault(join(dir, "accounts.enc"), 2 * 1024 * 1024, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (bytes) {
      try {
        if (bytes.length < 29 || bytes[0] !== 1) throw googleError("google_store_invalid", { detail: "format" });
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(1, 13));
        decipher.setAAD(Buffer.from(`yesimbot-google:${tenant}`));
        decipher.setAuthTag(bytes.subarray(13, 29));
        state = stateSchema.parse(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString("utf8")));
        if (state.tenant !== tenant) throw googleError("google_store_invalid", { detail: "tenant" });
      } catch (cause) {
        throw cause instanceof AppError && cause.code === "google_store_invalid" ? cause : googleError("google_store_invalid", { cause });
      }
    }
    return new GoogleStore(dir, key, state);
  }

  snapshot(): State {
    return structuredClone(this.state);
  }

  async change<T>(update: (draft: State) => T): Promise<T> {
    let result!: T;
    const task = this.tail.then(async () => {
      const draft = structuredClone(this.state);
      result = update(draft);
      stateSchema.parse(draft);
      const iv = Buffer.from(newSecret(16), "base64url").subarray(0, 12),
        cipher = createCipheriv("aes-256-gcm", this.key, iv);
      cipher.setAAD(Buffer.from(`yesimbot-google:${draft.tenant}`));
      const body = Buffer.concat([cipher.update(JSON.stringify(draft)), cipher.final()]);
      const bytes = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
      await writeFileAtomic(join(this.dir, "accounts.enc"), bytes);
      this.state = draft;
    });
    this.tail = task.catch(() => {});
    await task;
    return result;
  }
}

/** A vault file read without following a link; a link, a loose mode or a wrong size means it cannot be trusted. */
async function readVault(path: string, maxBytes: number, mode0600: boolean): Promise<Buffer> {
  try {
    return await readPrivateFile(path, { maxBytes, mode0600 });
  } catch (cause) {
    if (cause instanceof AppError && ["path_is_link", "file_not_private", "file_too_large", "path_missing"].includes(cause.code))
      throw googleError("google_store_invalid", { cause });
    throw cause;
  }
}
