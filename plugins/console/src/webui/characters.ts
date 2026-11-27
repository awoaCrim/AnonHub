import { roleCardPictureType } from "@yesimbot/character-cards";
import { ROLE_CARD_PICTURE_MAX_BYTES } from "@yesimbot/contracts/role-cards";

import { readAdminLoginBody, type AdminAuth } from "../admin-auth.js";
import { CardError, CharacterCards } from "../characters/store.js";
import { ConfigError, type ConfigStore } from "../config/store.js";
import type { Host } from "../host.js";
import { readRaw } from "./chat-uploads.js";
import { authorizeOwner, type HttpContext } from "./plugins.js";

export function installCharacters(ctx: Host, auth: AdminAuth, store: ConfigStore) {
  const cards = new CharacterCards(store);
  const failure = (http: HttpContext, error: unknown) => {
    if (error instanceof CardError || error instanceof ConfigError) {
      http.status = error.status;
      http.body = { message: error.code, ...(error.restored !== undefined ? { restored: error.restored } : {}) };
    } else {
      http.status = 400;
      http.body = { message: "invalid_card" };
    }
  };
  ctx.server.get("/yesimbot/api/v1/characters", async (http) => {
    if (!authorizeOwner(http, auth)) return;
    try {
      if (typeof http.query.path !== "string" || (http.query.id !== undefined && typeof http.query.id !== "string")) throw new CardError(400, "invalid_card");
      const result = await cards.snapshot(http.query.path, http.query.id as string | undefined);
      if (authorizeOwner(http, auth)) http.body = result;
    } catch (error) {
      if (authorizeOwner(http, auth)) failure(http, error);
    }
  });
  ctx.server.get("/yesimbot/api/v1/characters/picture", async (http) => {
    if (!authorizeOwner(http, auth)) return;
    try {
      const { path, id, key } = http.query;
      if (typeof path !== "string" || typeof id !== "string" || (key !== "reference" && key !== "turnaround")) throw new CardError(400, "invalid_card");
      const { bytes, mediaType, etag } = await cards.picture(path, id, key);
      if (!authorizeOwner(http, auth)) return;
      http.set("Cache-Control", "private, max-age=300");
      http.set("ETag", `"${etag}"`);
      http.set("X-Content-Type-Options", "nosniff");
      if (http.get("If-None-Match") === `"${etag}"`) {
        http.status = 304;
        return;
      }
      http.type = mediaType;
      http.body = Buffer.from(bytes);
    } catch (error) {
      if (authorizeOwner(http, auth)) failure(http, error);
    }
  });
  // The raw image is the body; `key` names the picture, `remove=1` with an empty body removes it.
  ctx.server.post("/yesimbot/api/v1/characters/picture", async (http) => {
    if (!authorizeOwner(http, auth, true)) return;
    try {
      const { path, revision, id, etag, key, remove } = http.query;
      if (typeof path !== "string" || typeof revision !== "string" || typeof id !== "string" || typeof etag !== "string")
        throw new CardError(400, "invalid_card");
      let bytes: Buffer;
      try {
        bytes = await readRaw(http, ROLE_CARD_PICTURE_MAX_BYTES);
      } catch {
        throw new CardError(413, "invalid_picture");
      }
      const mediaType = bytes.length ? roleCardPictureType(bytes) : undefined;
      if (remove === "1" ? bytes.length : !mediaType) throw new CardError(400, "invalid_picture");
      const picture = remove === "1" ? null : { bytes: new Uint8Array(bytes), mediaType };
      const result = await cards.mutate(revision, path, "picture", { id, etag, key, picture });
      if (authorizeOwner(http, auth, true)) http.body = result;
    } catch (error) {
      if (authorizeOwner(http, auth, true)) failure(http, error);
    }
  });
  for (const action of ["save", "create", "switch", "remove"] as const) {
    ctx.server.post(`/yesimbot/api/v1/characters/${action}`, async (http) => {
      if (!authorizeOwner(http, auth, true)) return;
      try {
        const input = (await readAdminLoginBody(http, 1024 * 1024)) as Record<string, unknown>;
        if (typeof input.path !== "string" || typeof input.revision !== "string") throw new CardError(400, "invalid_card");
        const result = await cards.mutate(input.revision, input.path, action, input);
        if (authorizeOwner(http, auth, true)) http.body = result;
      } catch (error) {
        if (authorizeOwner(http, auth, true)) failure(http, error);
      }
    });
  }
}
