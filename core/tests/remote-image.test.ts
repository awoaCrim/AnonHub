import { isIP } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resourceErrorCode } from "../src/resources/index.js";
import { fetchRemoteImage } from "../src/resources/remote-image.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const PUBLIC = async () => [{ address: "93.184.216.34" }];

/** Waits until aborted, like a download that never answers. */
const hang: typeof globalThis.fetch = (_input, init) =>
  new Promise((_, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

/** `fetchRemoteImage` with `fetch` as the global fetch `httpFetch` calls and `lookup` as its resolver. */
function get(
  uri: string,
  fetch: typeof globalThis.fetch,
  options: { lookup: (host: string) => Promise<readonly { address: string }[]>; timeoutMs?: number; signal?: AbortSignal },
) {
  vi.stubGlobal("fetch", fetch);
  const { lookup, ...rest } = options;
  return fetchRemoteImage(uri, { ...rest, seams: { lookup: async (host) => (await lookup(host)).map(({ address }) => ({ address, family: isIP(address) })) } });
}

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  return resourceErrorCode(error) ?? error;
}

// User, 2026-11-20: 「推文中的图片也看不到」: tweets give their pictures as pbs.twimg.com addresses.
describe("pictures by public web address", () => {
  it("downloads a public picture, following redirects only through its own checks", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(PNG, { headers: { "content-type": "image/png" } }));
    const image = await get("https://pbs.twimg.com/media/GxYz.png?name=orig", fetch, { lookup: PUBLIC });
    expect(image).toMatchObject({ mediaType: "image/png", filename: "GxYz.png" });
    expect(Buffer.from(image.bytes)).toEqual(Buffer.from(PNG));
    expect(String(fetch.mock.calls[0]![0])).toBe("https://pbs.twimg.com/media/GxYz.png?name=orig");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  });

  it("follows a redirect only to another public https address", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://cdn.example.test/x.jpg" } }))
      .mockResolvedValueOnce(new Response(JPEG, { headers: { "content-type": "image/jpeg" } }));
    await expect(get("https://example.test/x", fetch, { lookup: PUBLIC })).resolves.toMatchObject({ mediaType: "image/jpeg", filename: "x.jpg" });
    for (const location of ["https://127.0.0.1/x.png", "http://cdn.example.test/x.png", "https://localhost/x.png"]) {
      const hop = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(null, { status: 301, headers: { location } }));
      expect({ location, code: await failure(get("https://example.test/x", hop, { lookup: PUBLIC })) }).toEqual({
        location,
        code: "resource_uri_invalid",
      });
      expect(hop).toHaveBeenCalledTimes(1);
    }
    const loop = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 302, headers: { location: "https://example.test/again" } }));
    expect(await failure(get("https://example.test/x", loop, { lookup: PUBLIC }))).toBe("resource_unavailable");
    expect(loop).toHaveBeenCalledTimes(4);
  });

  it("refuses addresses that would reach the bot's own machine or network", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const uri of [
      "http://example.test/a.png",
      "https://user:secret@example.test/a.png",
      "https://example.test:8443/a.png",
      "https://127.0.0.1/a.png",
      "https://[::1]/a.png",
      "https://10.1.2.3/a.png",
      "https://localhost/a.png",
      "https://intranet/a.png",
      "https://printer.local/a.png",
      "ftp://example.test/a.png",
      "not a web address",
    ])
      expect({ uri, code: await failure(get(uri, fetch, { lookup: PUBLIC })) }).toEqual({ uri, code: "resource_uri_invalid" });
    // A public-looking name resolving to the machine or a private network, Mihomo's fake-ip range included.
    for (const address of [
      "127.0.0.1",
      "10.0.0.8",
      "172.20.0.2",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "198.18.0.5",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      const lookup = async () => [{ address: "93.184.216.34" }, { address }];
      expect({ address, code: await failure(get("https://rebind.example.test/a.png", fetch, { lookup: lookup })) }).toEqual({
        address,
        code: "resource_uri_invalid",
      });
    }
    const missing = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await failure(get("https://missing.example.test/a.png", fetch, { lookup: missing }))).toBe("resource_unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns only real pictures of at most 5 MiB", async () => {
    const cases: [string, Response, string][] = [
      ["html page", new Response("<html></html>", { headers: { "content-type": "text/html" } }), "resource_not_image"],
      ["untyped words", new Response("plain words", { headers: { "content-type": "application/octet-stream" } }), "resource_not_image"],
      ["svg", new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }), "resource_not_image"],
      ["declared too large", new Response(PNG, { headers: { "content-type": "image/png", "content-length": String(6 * 1024 * 1024) } }), "resource_too_large"],
      ["streamed too large", new Response(new Uint8Array(5 * 1024 * 1024 + 1)), "resource_too_large"],
      ["not found", new Response("missing", { status: 404 }), "resource_unavailable"],
    ];
    for (const [name, response, code] of cases)
      expect({ name, code: await failure(get("https://example.test/a.png", async () => response, { lookup: PUBLIC })) }).toEqual({
        name,
        code,
      });
  });

  it("stops at its deadline and when the turn is aborted", async () => {
    expect(await failure(get("https://example.test/a.png", hang, { lookup: PUBLIC, timeoutMs: 20 }))).toBe("resource_timeout");
    const controller = new AbortController();
    const pending = get("https://example.test/a.png", hang, { lookup: PUBLIC, signal: controller.signal });
    controller.abort();
    expect(await failure(pending)).toBe("resource_read_aborted");
  });
});
