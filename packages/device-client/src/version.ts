/** This client's release version, e.g. `2026.1107.1930`. Builds from source are `0.0.0-dev` and never update themselves. */
export const CLIENT_VERSION: string = typeof __YESIMBOT_CLIENT_VERSION__ === "string" ? __YESIMBOT_CLIENT_VERSION__ : "0.0.0-dev";

/** Set when a release is packaged (`scripts/package-device-client.mjs --client-version`). */
declare const __YESIMBOT_CLIENT_VERSION__: string | undefined;

/** A packaged release, as opposed to a build from source. */
export const isReleaseVersion = (version: string) => /^[0-9]{1,6}(\.[0-9]{1,6}){1,3}$/.test(version);

/** Numeric comparison by dotted parts; missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number),
    right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}
