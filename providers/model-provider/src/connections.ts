import { AppError } from "@yesimbot/foundation";

import type * as anthropic from "./anthropic.js";
import type * as deepseek from "./deepseek.js";
import { MODEL_PROVIDER_ERRORS } from "./errors.js";
import type * as google from "./google.js";
import type * as openai from "./openai.js";

export type ProtocolConfig =
  | ({ type: "openai" } & openai.Config)
  | ({ type: "anthropic" } & anthropic.Config)
  | ({ type: "google" } & google.Config)
  | ({ type: "deepseek" } & deepseek.Config);

/** Explicitly disabled connections retain incomplete and protocol-specific settings. */
export type ConnectionConfig = (ProtocolConfig & { enabled?: true }) | ({ enabled: false } & Record<string, unknown>);

export type Config = { connections: ConnectionConfig[] };

/** The enabled connections of a normalized config; each needs a provider ID of its own. */
export function activeConnections(normalized: Config): ProtocolConfig[] {
  const active = normalized.connections.filter((connection): connection is ProtocolConfig & { enabled?: true } => connection.enabled !== false);
  const ids = new Set<string>();
  for (const connection of active) {
    if (typeof connection.id !== "string" || !connection.id.trim()) throw new AppError(MODEL_PROVIDER_ERRORS.model_provider_id_missing, { effect: "none" });
    if (ids.has(connection.id)) throw new AppError(MODEL_PROVIDER_ERRORS.model_provider_id_duplicate, { effect: "none", detail: connection.id });
    ids.add(connection.id);
  }
  return active;
}
