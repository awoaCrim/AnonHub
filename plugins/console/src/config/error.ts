import type { PluginConfigErrorCode } from "../shared/plugin-config.js";

export class ConfigError extends Error {
  constructor(
    readonly status: number,
    readonly code: PluginConfigErrorCode,
    readonly path?: string,
    readonly restored?: boolean,
  ) {
    super(code);
  }
}

export const configPathKey = (key: string): string => key.replaceAll("%", "%25").replaceAll("/", "%2F");

export const decodeKey = (key: string): string => {
  try {
    return decodeURIComponent(key);
  } catch {
    throw new ConfigError(404, "not_found");
  }
};
