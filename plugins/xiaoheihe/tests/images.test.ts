import { afterEach, describe, expect, it, vi } from "vitest";

import { storeImages } from "../src/images.js";

const image = (bytes = 4, type = "image/jpeg") => new Response(new Uint8Array(bytes), { headers: { "content-type": type } });

afterEach(() => vi.unstubAllGlobals());

describe("post image storage", () => {
  it("stores only allowlisted https images and skips failures", async () => {
    const fetchImpl = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.includes("broken")) throw new Error("network");
      if (url.includes("page")) return image(4, "text/html");
      return image();
    });
    vi.stubGlobal("fetch", fetchImpl);
    const put = vi.fn(async () => "f".repeat(32));
    const stored = await storeImages(
      [
        "https://imgheybox.max-c.com/a.jpg",
        "https://evil.example/b.jpg",
        "https://imgheybox.max-c.com/broken.jpg",
        "https://cdn.max-c.com/page.jpg",
        "https://imgheybox.max-c.com/fifth.jpg",
      ],
      put,
    );
    expect(stored).toEqual([`asset://${"f".repeat(32)}`]);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).not.toContain("https://evil.example/b.jpg");
    // At most four candidates are considered.
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).not.toContain("https://imgheybox.max-c.com/fifth.jpg");
  });

  it("rejects images over the byte limit", async () => {
    const put = vi.fn(async () => "id");
    vi.stubGlobal("fetch", async () => image(9 * 1024 * 1024));
    expect(await storeImages(["https://imgheybox.max-c.com/a.jpg"], put)).toEqual([]);
    expect(put).not.toHaveBeenCalled();
  });
});
