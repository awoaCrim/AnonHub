import { link, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { Channels, deriveChannelKey } from "../src/channels/index.js";
import { RuntimeIdentity } from "../src/devices.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temp() {
  const root = await mkdtemp(join(tmpdir(), "runtime-identity-"));
  roots.push(root);
  return root;
}

it("atomically keeps one runtime tenant identity and rejects a volume assigned to a different tenant", async () => {
  const root = await temp();
  const ids = await Promise.all(Array.from({ length: 8 }, () => new RuntimeIdentity(root).tenantId()));
  expect(new Set(ids).size).toBe(1);
  expect(await new RuntimeIdentity(root, ids[0]).tenantId()).toBe(ids[0]);
  await expect(new RuntimeIdentity(root, "11111111-1111-4111-8111-111111111111").tenantId()).rejects.toThrow("identity_tenant_mismatch");
});

it("waits out a concurrent creator's temporary link name but rejects a lasting hard link", async () => {
  for (let round = 0; round < 5; round++) {
    const root = await temp();
    const ids = await Promise.all(Array.from({ length: 24 }, () => new RuntimeIdentity(root).tenantId()));
    expect(new Set(ids).size).toBe(1);
  }
  const root = await temp();
  await new RuntimeIdentity(root).tenantId();
  await link(join(root, "runtime-identity.json"), join(root, "extra-name.json"));
  await expect(new RuntimeIdentity(root).tenantId()).rejects.toThrow("identity_file_invalid");
});

it("separates group resources and histories for two bots and does not adopt ownerless historical storage", async () => {
  const channels = new Channels({ basePath: await temp() });
  const base = { type: "guild" as const, platform: "test", channelId: "group", guildId: "group" };
  const legacy = await channels.resolve(base),
    first = await channels.resolve({ ...base, selfId: "bot-a" }),
    second = await channels.resolve({ ...base, selfId: "bot-b" });
  expect(new Set([legacy.root, first.root, second.root]).size).toBe(3);
  expect(first.resources).not.toBe(second.resources);
  expect(deriveChannelKey({ ...base, selfId: "bot-a" })).not.toBe(deriveChannelKey({ ...base, selfId: "bot-b" }));
  const nested = { type: "channel" as const, platform: "a:b", selfId: "bot", guildId: "c", channelId: "d" };
  expect(deriveChannelKey(nested)).not.toBe(deriveChannelKey({ ...nested, platform: "a", guildId: "b:c" }));
});
