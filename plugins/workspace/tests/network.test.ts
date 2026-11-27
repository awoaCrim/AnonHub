import { afterEach, describe, expect, it, vi } from "vitest";

import { createGitHttpClient } from "../src/git";

const lookup = async (host: string) => {
  if (host === "myhost.local") throw new Error("ENOTFOUND");
  if (host === "localhost")
    return [
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ];
  return [{ address: host === "intranet.example" ? "172.16.0.9" : "140.82.112.3", family: 4 }];
};
const ok = () => new Response("ok", { status: 200 });

async function reachable(url: string): Promise<boolean> {
  const send = vi.fn(async () => ok());
  vi.stubGlobal("fetch", send);
  const http = createGitHttpClient({ network: {} }, { lookup, insecureHttp: true })!;
  try {
    await http.request({ url, method: "GET", headers: {} });
    return true;
  } catch {
    expect(send).not.toHaveBeenCalled();
    return false;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("network security", () => {
  it("blocks loopback", async () => {
    for (const url of ["http://localhost/r.git", "http://127.0.0.1/r.git", "http://127.0.0.2/r.git", "http://[::1]/r.git"])
      expect(await reachable(url)).toBe(false);
  });

  it("blocks private, link-local and mapped ranges, and names that resolve into them", async () => {
    for (const url of [
      "http://10.0.0.1/r.git",
      "http://192.168.1.1/r.git",
      "http://172.31.255.255/r.git",
      "http://169.254.169.254/",
      "http://[::ffff:10.0.0.1]/",
      "https://intranet.example/r.git",
    ])
      expect(await reachable(url)).toBe(false);
  });

  it("blocks names that do not resolve, .local included", async () => {
    expect(await reachable("http://myhost.local/r.git")).toBe(false);
  });

  it("allows public hosts", async () => {
    for (const url of ["https://github.com/a/b.git", "https://8.8.8.8/r.git", "https://codeload.github.com/a/b"]) expect(await reachable(url)).toBe(true);
  });
});
