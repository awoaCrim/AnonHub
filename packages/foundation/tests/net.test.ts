import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppError, httpFetch, isPublicAddress, type HttpFetchSeams } from "../src/index.js";

let server: Server;
let port: number;
const seen: Array<{ url: string; method: string; host?: string; authorization?: string; body: string }> = [];
const routes: Record<string, (request: IncomingMessage, response: ServerResponse) => void> = {
  "/ok": (_request, response) => response.end("hello"),
  "/json": (_request, response) => response.end('{"a":1}'),
  "/big-declared": (_request, response) => response.writeHead(200, { "content-length": "2048" }).end("x".repeat(2048)),
  "/big-chunked": (_request, response) => {
    response.write("x".repeat(1024));
    response.end("x".repeat(1024));
  },
  "/slow": () => undefined,
  // Headers at once, then one chunk every 60 ms: a stream that outlives a short deadline.
  "/trickle": (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    let sent = 0;
    const timer = setInterval(() => {
      if (++sent === 5) {
        clearInterval(timer);
        response.end("x");
      } else response.write("x");
    }, 60);
  },
  "/to-ok": (_request, response) => response.writeHead(302, { location: "/ok" }).end(),
  "/see-other": (_request, response) => response.writeHead(303, { location: "/ok" }).end(),
  "/to-private": (_request, response) => response.writeHead(302, { location: `http://private.test:${port}/ok` }).end(),
  "/to-other-origin": (_request, response) => response.writeHead(307, { location: `http://other.test:${port}/ok` }).end(),
  "/loop": (_request, response) => response.writeHead(302, { location: "/loop" }).end(),
};

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      seen.push({ url: request.url!, method: request.method!, host: request.headers.host, authorization: request.headers.authorization, body });
      (routes[request.url!] ?? ((_q, r) => r.writeHead(404).end()))(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const names: Record<string, string> = { "public.test": "127.0.0.1", "other.test": "127.0.0.1", "private.test": "10.0.0.7" };
const seams: HttpFetchSeams = {
  insecureHttp: true,
  lookup: async (host) => {
    if (!names[host]) throw new Error("ENOTFOUND");
    return [{ address: names[host]!, family: 4 }];
  },
  // The local test server stands in for a public host.
  isPublic: (address) => address === "127.0.0.1" || isPublicAddress(address),
};
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof AppError ? error.code : String((error as Error)?.message ?? error)),
  );
const untrusted = (path: string, extra: Record<string, unknown> = {}) =>
  httpFetch(`http://public.test:${port}${path}`, { purpose: "untrusted", timeoutMs: 2000, maxBytes: 1024, seams, ...extra });

describe("isPublicAddress", () => {
  it.each([
    ["8.8.8.8", true],
    ["140.82.112.3", true],
    ["::ffff:8.8.8.8", true],
    ["2606:4700::1111", true],
    ["10.0.0.1", false],
    ["127.0.0.2", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["198.18.0.1", false],
    ["192.0.2.1", false],
    ["224.0.0.1", false],
    ["255.255.255.255", false],
    ["0.0.0.0", false],
    ["::1", false],
    ["[::1]", false],
    ["::", false],
    ["::ffff:10.0.0.1", false],
    ["::ffff:a00:1", false],
    ["0:0:0:0:0:ffff:7f00:1", false],
    ["::127.0.0.1", false],
    ["64:ff9b::a00:1", false],
    ["2002:a00:1::", false],
    ["2001:db8::1", false],
    ["fc00::1", false],
    ["fe80::1", false],
    ["ff02::1", false],
    ["localhost", false],
    ["not an ip", false],
  ])("%s → %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});

describe("httpFetch untrusted", () => {
  it("connects to the checked address it resolved, keeping the host name", async () => {
    seen.length = 0;
    const response = await untrusted("/ok");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
    expect(seen[0]).toMatchObject({ host: `public.test:${port}` });
    expect(await (await untrusted("/json")).json()).toEqual({ a: 1 });
  });

  it("refuses http without the test seam, URL credentials, private names and unknown names before sending", async () => {
    seen.length = 0;
    expect(
      await code(httpFetch(`http://public.test:${port}/ok`, { purpose: "untrusted", timeoutMs: 1000, maxBytes: 10, seams: { ...seams, insecureHttp: false } })),
    ).toBe("network_url_invalid");
    expect(await code(httpFetch(`http://user:pw@public.test:${port}/ok`, { purpose: "untrusted", timeoutMs: 1000, maxBytes: 10, seams }))).toBe(
      "network_url_invalid",
    );
    expect(await code(httpFetch(`http://private.test:${port}/ok`, { purpose: "untrusted", timeoutMs: 1000, maxBytes: 10, seams }))).toBe(
      "network_destination_blocked",
    );
    expect(await code(httpFetch(`http://10.1.2.3:${port}/ok`, { purpose: "untrusted", timeoutMs: 1000, maxBytes: 10, seams }))).toBe(
      "network_destination_blocked",
    );
    expect(await code(httpFetch(`http://nowhere.test:${port}/ok`, { purpose: "untrusted", timeoutMs: 1000, maxBytes: 10, seams }))).toBe("network_dns_failed");
    expect(await code(httpFetch("ftp://public.test/x", { purpose: "untrusted", timeoutMs: 1000, maxBytes: 10, seams }))).toBe("network_url_invalid");
    expect(seen).toEqual([]);
  });

  it("counts a slow DNS lookup against the deadline and stops it with the caller's signal", async () => {
    const hang = { insecureHttp: true, lookup: () => new Promise<never>(() => undefined) };
    const started = Date.now();
    expect(await code(httpFetch("http://slow.test/x", { purpose: "untrusted", timeoutMs: 100, maxBytes: 10, seams: hang }))).toBe("network_timeout");
    expect(Date.now() - started).toBeLessThan(2000);
    const controller = new AbortController();
    const pending = httpFetch("http://slow.test/x", { purpose: "untrusted", timeoutMs: 10_000, maxBytes: 10, seams: hang, signal: controller.signal });
    controller.abort(new Error("stopped by caller"));
    await expect(pending).rejects.toThrow("stopped by caller");
  });

  it("refuses another port and local names before resolving them", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    for (const url of [
      "https://example.test:8443/a.png",
      "https://localhost/a.png",
      "https://printer.local/a.png",
      "https://intranet/a.png",
      "https://app.localhost/",
    ])
      expect({ url, code: await code(httpFetch(url, { purpose: "untrusted", timeoutMs: 1000, maxBytes: 10, seams: { lookup } })) }).toEqual({
        url,
        code: "network_url_invalid",
      });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("checks every redirect hop before sending it, and stops after three", async () => {
    seen.length = 0;
    expect(await (await untrusted("/to-ok")).text()).toBe("hello");
    expect(await code(untrusted("/to-private"))).toBe("network_destination_blocked");
    expect(seen.map((request) => request.url)).toEqual(["/to-ok", "/ok", "/to-private"]);
    seen.length = 0;
    expect(await code(untrusted("/loop"))).toBe("network_too_many_redirects");
    expect(seen).toHaveLength(4);
  });

  it("drops credentials on a cross-origin redirect and turns a 303 into a GET", async () => {
    seen.length = 0;
    await untrusted("/to-other-origin", { headers: { authorization: "Bearer secret-value" }, method: "POST", body: "payload" });
    expect(seen.map(({ url, method, authorization, body }) => ({ url, method, authorization, body }))).toEqual([
      { url: "/to-other-origin", method: "POST", authorization: "Bearer secret-value", body: "payload" },
      { url: "/ok", method: "POST", authorization: undefined, body: "payload" },
    ]);
    seen.length = 0;
    await untrusted("/see-other", { method: "POST", body: "payload" });
    expect(seen.map(({ method, body }) => ({ method, body }))).toEqual([
      { method: "POST", body: "payload" },
      { method: "GET", body: "" },
    ]);
  });

  it("stops a body past the limit, by header or while it streams", async () => {
    expect(await code(untrusted("/big-declared"))).toBe("network_response_too_large");
    const response = await untrusted("/big-chunked");
    expect(await code(response.bytes())).toBe("network_response_too_large");
  });

  it("times out, and passes the caller's abort through unwrapped", async () => {
    expect(await code(untrusted("/slow", { timeoutMs: 100 }))).toBe("network_timeout");
    const controller = new AbortController();
    const pending = untrusted("/slow", { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("caller stopped")), 50);
    expect(await code(pending)).toBe("caller stopped");
  });
});

describe("httpFetch internal and public", () => {
  it("internal reaches loopback, refuses public destinations and does not follow redirects", async () => {
    const options = { purpose: "internal" as const, timeoutMs: 1000, maxBytes: 1024 };
    expect(await (await httpFetch(`http://127.0.0.1:${port}/ok`, options)).text()).toBe("hello");
    expect(await (await httpFetch(`http://localhost:${port}/ok`, options)).text()).toBe("hello");
    const redirect = await httpFetch(`http://127.0.0.1:${port}/to-ok`, options);
    expect(redirect.status).toBe(302);
    await redirect.cancel();
    expect(await code(httpFetch("http://8.8.8.8/", options))).toBe("network_destination_blocked");
  });

  it("with deadline headers, bounds only the wait for the headers; the body may outlive it but not maxBytes", async () => {
    const options = { purpose: "internal" as const, timeoutMs: 150, maxBytes: 1024 };
    expect(await code((await httpFetch(`http://127.0.0.1:${port}/trickle`, options)).text())).toBe("network_timeout");
    const stream = await httpFetch(`http://127.0.0.1:${port}/trickle`, { ...options, deadline: "headers" });
    expect(await stream.text()).toBe("xxxxx");
    expect(await code(httpFetch(`http://127.0.0.1:${port}/slow`, { ...options, deadline: "headers" }))).toBe("network_timeout");
    const capped = await httpFetch(`http://127.0.0.1:${port}/trickle`, { ...options, maxBytes: 2, deadline: "headers" });
    expect(await code(capped.bytes())).toBe("network_response_too_large");
  });

  it("public follows redirects and still bounds the body", async () => {
    const options = { purpose: "public" as const, timeoutMs: 1000, maxBytes: 1024 };
    expect(await (await httpFetch(`http://127.0.0.1:${port}/to-ok`, options)).text()).toBe("hello");
    expect(await code(httpFetch(`http://127.0.0.1:${port}/big-declared`, options))).toBe("network_response_too_large");
    await expect(httpFetch(`http://127.0.0.1:${port}/ok`, { ...options, timeoutMs: 0 })).rejects.toThrow(RangeError);
  });
});
