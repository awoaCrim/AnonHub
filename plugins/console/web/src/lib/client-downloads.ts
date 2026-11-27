import { api } from "./api";

/** One published device-client package, as listed in the site's `/downloads/client.json`. */
export type ClientRelease = { platform: "windows-x64" | "portable"; url: string; size: number; sha256: string };
export interface ClientDownloads {
  /** The gateway address to enter in the client, when the site publishes one. */
  gateway?: string;
  releases: ClientRelease[];
}

/** Reads and checks the download manifest; only same-site ZIPs with a size and SHA-256 are offered. */
export async function loadClientDownloads(): Promise<ClientDownloads> {
  const result = await api<{ version: number; gateway?: string; releases: ClientRelease[] }>("/downloads/client.json", undefined, { fresh: true });
  if (result.version !== 1 || !Array.isArray(result.releases)) throw new Error("invalid_release_manifest");
  const releases = result.releases.filter(
    (release) =>
      release &&
      ["windows-x64", "portable"].includes(release.platform) &&
      /^\/downloads\/[a-zA-Z0-9._-]+\.zip$/.test(release.url) &&
      /^[a-f0-9]{64}$/.test(release.sha256) &&
      Number.isSafeInteger(release.size) &&
      release.size > 0,
  );
  if (!releases.length) throw new Error("no_client_releases");
  let gateway: string | undefined;
  if (result.gateway) {
    const url = new URL(result.gateway);
    if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) gateway = url.href.replace(/\/$/, "");
  }
  return { gateway, releases };
}

export const releaseLabel = (release: ClientRelease) => (release.platform === "windows-x64" ? "Windows x64" : "macOS / Linux 通用包");
