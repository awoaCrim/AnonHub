import { afterEach, describe, expect, it, vi } from "vitest";

import { PNG_BYTES } from "../../image-tools/tests/helpers.js";
import { downloadReferenceImage } from "../src/reference-download.js";
import { stubFetch } from "./helpers.js";

const ADDRESS = { address: "93.184.216.34", family: 4 };
const options = { timeoutMs: 1000, maxBytes: 1024 };

function image(bytes: Uint8Array = PNG_BYTES, headers: Record<string, string> = { "content-type": "image/png" }, status = 200): Response {
  return new Response(bytes, { status, headers });
}

function fixture(reply: () => Response = () => image()) {
  const lookup = vi.fn(async (_hostname: string) => [ADDRESS]);
  const fetch = stubFetch(() => reply());
  return { lookup, fetch, seams: { lookup } };
}

/** A body that sends `first` and then stalls until the request is aborted, as a real connection does. */
function stalled(first: Uint8Array, signal: AbortSignal): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(first);
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("bounded public reference downloads", () => {
  it("connects to a validated address, sends no credentials, and checks the answer once", async () => {
    const f = fixture();
    const result = await downloadReferenceImage("https://images.example/a.png?token=not-logged", { ...options, seams: f.seams });
    expect(result).toMatchObject({ width: 1, height: 1, mediaType: "image/png", bytes: PNG_BYTES });
    expect(f.lookup).toHaveBeenCalledOnce();
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://images.example/a.png?token=not-logged");
    const headers = new Headers(init?.headers);
    expect(headers.get("user-agent")).toBe("Mozilla/5.0");
    expect(headers.get("accept")).toBe("image/png,image/jpeg,image/webp");
    expect([...headers.keys()].filter((name) => /authorization|cookie/.test(name))).toEqual([]);
    expect(init?.redirect).toBe("manual");
  });

  it.each([
    "file:///etc/passwd",
    "data:image/png;base64,AA==",
    "ftp://images.example/a.png",
    "https://user:password@images.example/a.png",
    "not-a-url",
    "http://images.example/a.png",
  ])("rejects URL %s without network access", async (url) => {
    const f = fixture();
    await expect(downloadReferenceImage(url, { ...options, seams: f.seams })).rejects.toMatchObject({ code: "search_image_url_invalid" });
    expect(f.lookup).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "224.0.0.1",
    "[::1]",
    "[fc00::1]",
    "[fe80::1]",
    "[::ffff:127.0.0.1]",
    "[2001:db8::1]",
    "[64:ff9b::7f00:1]",
  ])("rejects non-public destination %s", async (host) => {
    const f = fixture();
    await expect(downloadReferenceImage(`https://${host}/a.png`, { ...options, seams: f.seams })).rejects.toMatchObject({
      code: "search_image_unsafe_destination",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rejects a name that resolves to a local address, and a mixed public/private answer set", async () => {
    const f = fixture();
    f.lookup.mockResolvedValue([ADDRESS, { address: "10.0.0.1", family: 4 }]);
    await expect(downloadReferenceImage("https://images.example/a.png", { ...options, seams: f.seams })).rejects.toMatchObject({
      code: "search_image_unsafe_destination",
    });
    await expect(downloadReferenceImage("https://localhost/a.png", { ...options, seams: f.seams })).rejects.toMatchObject({ code: "search_image_url_invalid" });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("keeps the failed lookup as the cause", async () => {
    const f = fixture();
    f.lookup.mockRejectedValue(new Error("ENOTFOUND images.example"));
    const error = await downloadReferenceImage("https://images.example/a.png", { ...options, seams: f.seams }).catch((caught) => caught);
    expect(error).toMatchObject({ code: "search_image_dns_failed" });
    expect(error.cause).toMatchObject({ code: "network_dns_failed" });
  });

  it("revalidates redirect destinations before connection", async () => {
    const f = fixture(() => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } }));
    await expect(downloadReferenceImage("https://images.example/a.png", { ...options, seams: f.seams })).rejects.toMatchObject({
      code: "search_image_unsafe_destination",
    });
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("follows bounded public redirects with a freshly checked address per host", async () => {
    const redirect = () => new Response(null, { status: 302, headers: { location: "https://cdn.example/a.png" } });
    const f = fixture(redirect);
    f.fetch.mockImplementationOnce(async () => redirect()).mockImplementationOnce(async () => image());
    await expect(downloadReferenceImage("https://images.example/a.png", { ...options, seams: f.seams })).resolves.toMatchObject({ width: 1, height: 1 });
    expect(f.lookup.mock.calls.map(([host]) => host)).toEqual(["images.example", "cdn.example"]);
    const loop = fixture(redirect);
    await expect(downloadReferenceImage("https://images.example/a.png", { ...options, seams: loop.seams })).rejects.toMatchObject({
      code: "search_image_too_many_redirects",
    });
    expect(loop.fetch).toHaveBeenCalledTimes(4);
  });

  it("enforces streamed bytes without trusting Content-Length", async () => {
    const f = fixture(() => image(new Uint8Array([...PNG_BYTES, ...PNG_BYTES]), {}));
    await expect(downloadReferenceImage("https://images.example/a.png", { ...options, maxBytes: PNG_BYTES.byteLength, seams: f.seams })).rejects.toMatchObject({
      code: "search_image_too_large",
    });
  });

  it.each([
    { name: "html", reply: () => image(PNG_BYTES, { "content-type": "text/html" }), code: "search_image_invalid" },
    { name: "wrong type", reply: () => image(PNG_BYTES, { "content-type": "image/jpeg" }), code: "search_image_invalid" },
    { name: "gif type", reply: () => image(PNG_BYTES, { "content-type": "image/gif" }), code: "search_image_invalid" },
    { name: "truncated", reply: () => image(PNG_BYTES.subarray(0, 8), {}), code: "search_image_invalid" },
    { name: "length mismatch", reply: () => image(PNG_BYTES, { "content-length": "1" }), code: "search_image_invalid" },
    { name: "not found", reply: () => image(PNG_BYTES, {}, 404), code: "search_image_download_failed" },
  ])("rejects invalid content or status before returning an image: $name", async ({ reply, code }) => {
    const f = fixture(reply);
    await expect(downloadReferenceImage("https://images.example/a.png", { ...options, seams: f.seams })).rejects.toMatchObject({ code });
  });

  it("rejects declared overflow before reading a response body", async () => {
    const f = fixture(() => image(PNG_BYTES, { "content-length": "999999" }));
    await expect(downloadReferenceImage("https://images.example/a.png", { ...options, seams: f.seams })).rejects.toMatchObject({
      code: "search_image_too_large",
    });
  });

  it("bounds a stalled body with the deadline", async () => {
    stubFetch((_url, init) => stalled(PNG_BYTES.subarray(0, 8), init.signal));
    const seams = { lookup: async () => [ADDRESS] };
    await expect(downloadReferenceImage("https://images.example/a.png", { timeoutMs: 50, maxBytes: 1024, seams })).rejects.toMatchObject({
      code: "search_image_timeout",
    });
  });

  it("honors pre-abort and live cancellation without accepting partial pixels", async () => {
    const controller = new AbortController();
    controller.abort();
    const f = fixture();
    await expect(downloadReferenceImage("https://images.example/a.png", { ...options, signal: controller.signal, seams: f.seams })).rejects.toMatchObject({
      code: "search_image_aborted",
    });
    expect(f.lookup).not.toHaveBeenCalled();
    const live = new AbortController();
    stubFetch((_url, init) => {
      const reply = stalled(PNG_BYTES.subarray(0, 8), init.signal);
      setTimeout(() => live.abort(), 10);
      return reply;
    });
    await expect(
      downloadReferenceImage("https://images.example/a.png", { ...options, signal: live.signal, seams: { lookup: async () => [ADDRESS] } }),
    ).rejects.toMatchObject({ code: "search_image_aborted" });
  });
});
