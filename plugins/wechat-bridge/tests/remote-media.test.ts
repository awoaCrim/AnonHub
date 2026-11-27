import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { isPublicAddress, type HttpFetchSeams } from "@yesimbot/foundation";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { remoteMediaFetcher } from "../src/media.js";

const PNG = new Uint8Array([137, 80, 78, 71]);
let server: Server;
let port: number;
const seen: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push(request.url!);
    if (request.url === "/a.png") response.writeHead(200, { "content-type": "image/png" }).end(Buffer.from(PNG));
    else if (request.url === "/to-private") response.writeHead(302, { location: `http://private.test:${port}/secret.png` }).end();
    else if (request.url === "/declared-big") response.writeHead(200, { "content-length": String(30 * 1024 * 1024) }).end();
    else if (request.url === "/chunked-big") {
      response.writeHead(200, { "content-type": "image/png" });
      const push = () => {
        if (response.destroyed) return;
        response.write(Buffer.alloc(8 * 1024 * 1024), push);
      };
      push();
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const names: Record<string, string> = { "cdn.test": "127.0.0.1", "private.test": "10.0.0.8", "intranet.test": "192.168.1.5" };
const seams: HttpFetchSeams = {
  insecureHttp: true,
  lookup: async (host) => {
    if (!names[host]) throw new Error("ENOTFOUND");
    return [{ address: names[host]!, family: 4 }];
  },
  // The local test server stands in for a public host.
  isPublic: (address) => address === "127.0.0.1" || isPublicAddress(address),
};
const fetchMedia = remoteMediaFetcher(seams);

describe("remote media for WeChat", () => {
  it.each(["http://127.0.0.1/a.png", "http://169.254.169.254/latest/meta-data", "https://[::1]/a.png", "http://intranet.test/a.png"])(
    "refuses %s before sending anything",
    async (url) => {
      seen.length = 0;
      // Without the test's stand-in for a public host, the server's own address is loopback.
      await expect(remoteMediaFetcher({ insecureHttp: true, lookup: seams.lookup! })(url)).rejects.toMatchObject({ code: "wechat_media_source_not_public" });
      expect(seen).toEqual([]);
    },
  );

  it("refuses an unusable address and credentials", async () => {
    await expect(fetchMedia("ftp://cdn.test/a.png")).rejects.toMatchObject({ code: "wechat_media_source_unsupported" });
    await expect(fetchMedia("https://user:pass@cdn.test/a.png")).rejects.toMatchObject({ code: "wechat_media_source_unsupported" });
    await expect(fetchMedia("not a url")).rejects.toMatchObject({ code: "wechat_media_source_unsupported" });
  });

  it("checks a redirect before following it", async () => {
    seen.length = 0;
    await expect(fetchMedia(`http://cdn.test:${port}/to-private`)).rejects.toMatchObject({ code: "wechat_media_source_not_public" });
    expect(seen).toEqual(["/to-private"]);
  });

  it("refuses a body that declares or streams more than the limit", async () => {
    await expect(fetchMedia(`http://cdn.test:${port}/declared-big`)).rejects.toMatchObject({ code: "wechat_media_too_large" });
    await expect(fetchMedia(`http://cdn.test:${port}/chunked-big`)).rejects.toMatchObject({ code: "wechat_media_too_large" });
  });

  it("reports a refusal from the server as a failed download", async () => {
    await expect(fetchMedia(`http://cdn.test:${port}/missing.png`)).rejects.toMatchObject({ code: "wechat_media_fetch_failed" });
  });

  it("downloads a public image", async () => {
    await expect(fetchMedia(`http://cdn.test:${port}/a.png`)).resolves.toEqual({ bytes: PNG, mediaType: "image/png" });
  });
});
