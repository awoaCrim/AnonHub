import { platformOfPackage } from "./web-platform";

/** Bot capabilities: the plugins listed under 已开启/未开启 on the plugins page and counted on the overview. */
const ELSEWHERE = new Set(["yesimbot-console", "yesimbot-model-provider", "yesimbot-roleplay", "yesimbot-device-connection"]);
export function isCapability(name: string): boolean {
  return name.startsWith("yesimbot-") && !ELSEWHERE.has(name) && !platformOfPackage(name);
}
