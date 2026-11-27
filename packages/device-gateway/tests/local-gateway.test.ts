import { manualClock } from "@yesimbot/foundation";
import { afterEach, expect, it, vi } from "vitest";

import { GatewayClient } from "../src/client.js";
import { localAddressAllowed, parseLocalNetworks } from "../src/local-listener.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const token = "a".repeat(64);

afterEach(() => vi.unstubAllGlobals());

it("accepts only connections that arrive on an allowed host-bridge address", () => {
  const networks = parseLocalNetworks("172.16.0.0/12, 192.168.241.0/28");
  for (const address of ["172.18.0.1", "172.24.0.1", "::ffff:172.19.0.1", "192.168.241.1"]) expect(localAddressAllowed(address, networks), address).toBe(true);
  // The LAN address of the same host, loopback, public and IPv6 addresses are refused.
  for (const address of ["192.168.71.161", "192.168.241.17", "127.0.0.1", "8.8.8.8", "172.32.0.1", "fd00::1", "", undefined])
    expect(localAddressAllowed(address, networks), String(address)).toBe(false);
  for (const bad of ["", "0.0.0.0/0", "192.168.0.0/8", "8.8.8.0/24", "127.0.0.0/8", "172.16.0.0", "172.16.0.0/33", "300.1.1.1/16"])
    expect(() => parseLocalNetworks(bad), bad).toThrow();
});

function refused() {
  return Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
}

function reset() {
  return Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
}
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const invocation = {
  operationId: "33333333-3333-4333-8333-333333333333",
  capability: "computer.desktop" as const,
  method: "cua",
  input: { tool: "get_desktop_state", args: {} },
  conversation: { tenantId, platform: "qq", botId: "1", kind: "direct" as const, conversationId: "c" },
  actors: [],
  expiresAt: Date.now() + 10_000,
};

it("prefers the local address and falls back to the public one only when that cannot repeat a write", async () => {
  const clock = manualClock(1_000);
  const calls: string[] = [];
  let local: () => Response | Promise<Response> = () => json([]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      calls.push(url.origin);
      if (url.origin === "http://172.18.0.1:17401") return local();
      return url.pathname === "/v1/invoke" ? json({ status: "succeeded", output: null }) : json([]);
    }),
  );
  const client = new GatewayClient({ gateway: "https://gateway.example", localGateway: "http://172.18.0.1:17401", token, tenantId }, clock);

  await client.list();
  expect(calls).toEqual(["http://172.18.0.1:17401"]);

  // A write whose connection was refused never reached the gateway: it goes to the public address once.
  calls.length = 0;
  local = () => {
    throw refused();
  };
  expect((await client.invoke(deviceId, invocation)).status).toBe("succeeded");
  expect(calls).toEqual(["http://172.18.0.1:17401", "https://gateway.example"]);

  // For a minute the local address is skipped.
  calls.length = 0;
  await client.list();
  expect(calls).toEqual(["https://gateway.example"]);

  // Then it is tried again. A write cut off mid-way is not repeated: its result is unknown.
  clock.advance(61_000);
  calls.length = 0;
  local = () => {
    throw reset();
  };
  expect(await client.invoke(deviceId, invocation)).toEqual({ status: "unknown", code: "gateway_result_unavailable" });
  expect(calls).toEqual(["http://172.18.0.1:17401"]);

  // A read is safe to repeat whatever went wrong.
  calls.length = 0;
  await client.list();
  expect(calls).toEqual(["http://172.18.0.1:17401", "https://gateway.example"]);
});

it("rejects a local address that is not a private host bridge", () => {
  expect(() => new GatewayClient({ gateway: "https://gateway.example", localGateway: "http://192.0.2.1:17401", token, tenantId })).toThrow();
  expect(() => new GatewayClient({ gateway: "https://gateway.example", localGateway: "https://172.18.0.1:17401", token, tenantId })).toThrow();
});

it("serves the local listener beside the proxied one and cuts off connections on other addresses", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { connect } = await import("node:net");
  const state = await mkdtemp(join(tmpdir(), "gateway-local-"));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const cli = join(state, "gateway.cjs");
  const { build } = await import("esbuild");
  await build({
    entryPoints: [join(__dirname, "../src/cli.ts")],
    outfile: cli,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["bufferutil", "utf-8-validate"],
    logLevel: "silent",
  });
  const run = (...args: string[]) => spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = (child: ReturnType<typeof run>) =>
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve(child.exitCode)
      : new Promise<number | null>((resolve) => child.once("exit", resolve));
  try {
    // A local port needs its allowed networks, and only private ones.
    expect(await exit(run("serve", "--state", state, "--port", String(port), "--local-port", String(port + 1)))).not.toBe(0);
    expect(await exit(run("serve", "--state", state, "--port", String(port), "--local-port", String(port + 1), "--local-allow", "0.0.0.0/0"))).not.toBe(0);

    const child = run("serve", "--state", state, "--port", String(port), "--local-port", String(port + 1), "--local-allow", "172.16.0.0/12");
    try {
      let output = "";
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("gateway did not start: " + output)), 15_000);
        child.stdout!.on("data", (chunk) => {
          output += chunk;
          if (output.includes("本机容器入口")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      // The proxied listener answers (no credential: 401).
      expect((await fetch(`http://127.0.0.1:${port}/v1/devices`)).status).toBe(401);
      // The local listener reached on loopback (not an allowed bridge address) is closed before any reply.
      const reply = await new Promise<string>((resolve) => {
        const socket = connect(port + 1, "127.0.0.1", () => socket.write("GET /v1/devices HTTP/1.1\r\nHost: x\r\n\r\n"));
        let data = "";
        socket.on("data", (chunk) => (data += chunk));
        socket.on("close", () => resolve(data));
        socket.on("error", () => {});
      });
      expect(reply).toBe("");
    } finally {
      child.kill("SIGTERM");
      await exit(child);
    }
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}, 40_000);
