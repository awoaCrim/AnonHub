import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const foundation = vi.hoisted(() => ({ configureNetwork: vi.fn() }));
vi.mock("@yesimbot/foundation", async (original) => ({ ...(await original<typeof import("@yesimbot/foundation")>()), ...foundation }));

import { startNetworkPolicy } from "../src/network.js";

const roots: string[] = [];
const stops: (() => void)[] = [];

afterEach(async () => {
  stops.splice(0).forEach((stop) => stop());
  foundation.configureNetwork.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function policyFile(content?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-network-"));
  roots.push(root);
  const file = join(root, "network.json");
  if (content !== undefined) await writeFile(file, content);
  return file;
}

async function start(file: string, env: NodeJS.ProcessEnv = {}): Promise<void> {
  stops.push(await startNetworkPolicy({ file, env, pollMs: 20 }));
}

describe("egress policy", () => {
  it("applies the policy file at startup", async () => {
    await start(await policyFile(JSON.stringify({ proxy: "http://172.18.0.1:7890", directHosts: ".internal.example" })));
    expect(foundation.configureNetwork).toHaveBeenCalledWith({ proxy: "http://172.18.0.1:7890", directHosts: ".internal.example" });
  });

  it("goes direct without a policy file", async () => {
    await start(await policyFile());
    expect(foundation.configureNetwork).toHaveBeenCalledWith({ directHosts: "" });
  });

  it("lets the environment override the file", async () => {
    await start(await policyFile(JSON.stringify({ proxy: "http://172.18.0.1:7890" })), {
      YESIMBOT_OUTBOUND_PROXY: "http://127.0.0.1:18443",
      YESIMBOT_DIRECT_HOSTS: "newapi",
    });
    expect(foundation.configureNetwork).toHaveBeenCalledExactlyOnceWith({ proxy: "http://127.0.0.1:18443", directHosts: "newapi" });
  });

  it("applies a changed file and keeps the last valid policy when the file breaks", async () => {
    const file = await policyFile(JSON.stringify({ proxy: "http://172.18.0.1:7890" }));
    await start(file);
    await writeFile(file, JSON.stringify({ proxy: "http://172.18.0.1:7891", directHosts: "newapi" }));
    await vi.waitFor(() => expect(foundation.configureNetwork).toHaveBeenLastCalledWith({ proxy: "http://172.18.0.1:7891", directHosts: "newapi" }));
    const calls = foundation.configureNetwork.mock.calls.length;
    await writeFile(file, "{not json");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(foundation.configureNetwork).toHaveBeenCalledTimes(calls);
  });
});
