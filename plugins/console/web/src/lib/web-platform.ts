import { PLATFORMS, platformOfAdapter, WEB_CHAT, type PlatformDefinition } from "@yesimbot/contracts/platforms";

/**
 * The web chat is a platform of its own (`web`): the account holder's private chat with their bot,
 * built into the console. It has no account to connect, no groups and no reply rules, so pages that
 * list platforms people connect or reply in leave it out.
 */
export const WEB_PLATFORM: string = WEB_CHAT.platform;

export const isWebPlatform = (id: string) => id === WEB_PLATFORM;

/** Platforms people connect an account to (QQ, 微信 …). */
export function connectablePlatforms(): PlatformDefinition[] {
  return PLATFORMS.filter((platform) => !isWebPlatform(platform.id));
}

/** Chat platforms that take reply-scope rules; the web chat is always allowed for its owner. */
export function replyPlatforms(): PlatformDefinition[] {
  return PLATFORMS.filter((platform) => !isWebPlatform(platform.id));
}

/**
 * The platform a plugin package connects. The console provides the web chat but is not a platform
 * package, so it never counts as one.
 */
export function platformOfPackage(name: string): PlatformDefinition | undefined {
  const platform = platformOfAdapter(name);
  return platform && !isWebPlatform(platform.id) ? platform : undefined;
}
