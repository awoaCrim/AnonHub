import { httpFetch } from "@yesimbot/foundation";

/** Hosts of xiaoheihe image CDNs; anything else in a post body is never fetched. */
const HOSTS = /(^|\.)(max-c\.com|xiaoheihe\.cn)$/;

const MAX_IMAGES = 4;

const MAX_BYTES = 8 * 1024 * 1024;

const TIMEOUT_MS = 10_000;

/**
 * Downloads a post's images into channel assets so the model can read them. Bounded in count,
 * size and time; a failed image is skipped, never retried, and never fails the caller.
 */
export async function storeImages(urls: readonly string[], put: (bytes: Uint8Array) => Promise<string>): Promise<string[]> {
  const assets: string[] = [];
  for (const raw of urls.slice(0, MAX_IMAGES)) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || !HOSTS.test(url.hostname)) continue;
      // The host is one of xiaoheihe's own CDNs, a known public service; a redirect is never followed.
      const response = await httpFetch(url.href, { purpose: "public", timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, maxRedirects: 0 });
      if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("image/")) {
        await response.cancel();
        continue;
      }
      const bytes = await response.bytes();
      if (bytes.byteLength) assets.push(`asset://${await put(bytes)}`);
    } catch {
      /* Skip this image: unreachable, not an image, or past the size limit. */
    }
  }
  return assets;
}
