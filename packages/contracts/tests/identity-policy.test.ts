import { describe, expect, it } from "vitest";

import { authorizeTool, conversationKey, denyToolPolicy, grantsTool, workspaceOwnerKey, type ConversationIdentity, type ToolPolicy } from "../src/index.js";

const conversation: ConversationIdentity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  botId: "bot-a",
  platform: "wechat",
  kind: "direct",
  conversationId: "user-a",
};
const tool = { name: "workspace.read", pluginId: "workspace", contexts: ["direct", "group"] as const };
const policy: ToolPolicy = {
  version: 1,
  direct: { enabled: true, tools: [tool.name] },
  group: { enabled: true, tools: [] },
  actors: [{ kind: "direct", platform: "wechat", conversationId: "*", userId: "user-a", botId: "bot-a" }],
};

describe("canonical identity", () => {
  it("separates tenants, bots, chat kinds, parents and opaque IDs without delimiter collisions", () => {
    const variants = [
      conversation,
      { ...conversation, tenantId: "22222222-2222-4222-8222-222222222222" },
      { ...conversation, botId: "bot-b" },
      { ...conversation, kind: "group" as const },
      { ...conversation, parentId: "parent" },
    ];
    expect(new Set(variants.map(conversationKey)).size).toBe(variants.length);
    expect(conversationKey({ ...conversation, botId: "a:b", conversationId: "c" })).not.toBe(
      conversationKey({ ...conversation, botId: "a", conversationId: "b:c" }),
    );
  });
  it("does not collapse personal, conversation and explicit shared spaces", () => {
    expect(workspaceOwnerKey({ kind: "personal", tenantId: conversation.tenantId, platform: "wechat", userId: "user-a" })).not.toBe(
      workspaceOwnerKey({ kind: "conversation", conversation }),
    );
    expect(() => workspaceOwnerKey({ kind: "shared", tenantId: conversation.tenantId, spaceId: "../private" })).toThrow();
  });
});

describe("context-specific tool authorization", () => {
  const identity = { conversation, actors: [{ platform: "wechat", userId: "user-a" }] };
  it("defaults to deny and keeps direct/group tool selections independent", () => {
    expect(authorizeTool(identity, tool, denyToolPolicy()).allowed).toBe(false);
    expect(authorizeTool(identity, tool, policy).allowed).toBe(true);
    expect(authorizeTool({ ...identity, conversation: { ...conversation, kind: "group" } }, tool, policy)).toEqual({ allowed: false, reason: "tool-disabled" });
  });
  it("grants a device method by its name or by the all-tools wildcard", () => {
    const all: ToolPolicy = { ...policy, direct: { enabled: true, tools: ["*"] } };
    expect(authorizeTool(identity, { ...tool, name: "computer.shell.exec" }, all).allowed).toBe(true);
    expect(grantsTool(["workspace.files.read"], "workspace.files.read")).toBe(true);
    expect(grantsTool(["workspace.files.read"], "computer.shell.exec")).toBe(false);
  });
  it("never exposes a group-only tool in a direct conversation", () => {
    expect(authorizeTool(identity, { ...tool, contexts: ["group"] }, policy)).toEqual({ allowed: false, reason: "unsupported-context" });
  });
  it("checks every current group sender and never uses an actor-less group identity", () => {
    const group = { ...identity, conversation: { ...conversation, kind: "group" as const } };
    const limited: ToolPolicy = { ...policy, group: policy.direct, actors: [{ kind: "any", platform: "wechat", conversationId: "*", userId: "user-a" }] };
    expect(authorizeTool(group, tool, limited).allowed).toBe(true);
    expect(authorizeTool({ ...group, actors: [...group.actors, { platform: "wechat", userId: "user-b" }] }, tool, limited).allowed).toBe(false);
    expect(authorizeTool({ ...group, actors: [] }, tool, limited).allowed).toBe(false);
    expect(authorizeTool({ ...group, actors: [{ platform: "qq", userId: "user-a" }] }, tool, limited).allowed).toBe(false);
  });
  it("leaves private chats to the channel allowlist: no sender limit applies", () => {
    expect(authorizeTool({ ...identity, actors: [{ platform: "wechat", userId: "user-b" }] }, tool, policy).allowed).toBe(true);
    expect(authorizeTool({ ...identity, actors: [] }, tool, policy).allowed).toBe(true);
  });
  it("keeps a sender limit to its chat kind and ignores conversation and bot IDs", () => {
    const both = { ...policy, group: policy.direct };
    const group = { ...conversation, kind: "group" as const };
    expect(authorizeTool({ ...identity, conversation: group, actors: [{ platform: "wechat", userId: "user-b" }] }, tool, both).allowed).toBe(true);
    const limited: ToolPolicy = { ...both, actors: [{ kind: "group", platform: "wechat", conversationId: "room-a", botId: "bot-b", userId: "user-a" }] };
    expect(authorizeTool({ ...identity, conversation: { ...group, conversationId: "room-z" } }, tool, limited).allowed).toBe(true);
    expect(authorizeTool({ ...identity, conversation: group, actors: [{ platform: "wechat", userId: "user-b" }] }, tool, limited).allowed).toBe(false);
    // A legacy rule without a sender opens the whole chat kind, whatever conversation it named.
    const open: ToolPolicy = { ...limited, actors: [...limited.actors, { kind: "group", platform: "wechat", conversationId: "room-a" }] };
    expect(authorizeTool({ ...identity, conversation: { ...group, conversationId: "room-z" }, actors: [] }, tool, open).allowed).toBe(true);
  });
});

it("separates QQ and WeChat tool selections and actor grants without changing legacy platforms", () => {
  const value: ToolPolicy = {
    version: 1,
    direct: { enabled: true, tools: ["legacy"] },
    group: { enabled: true, tools: ["legacy"] },
    actors: [{ kind: "any", platform: "*", conversationId: "*" }],
    platforms: {
      onebot: {
        direct: { enabled: true, tools: ["read"] },
        group: { enabled: true, tools: ["write"] },
        actors: [{ kind: "any", platform: "onebot", conversationId: "*", userId: "alice" }],
      },
      "wechat-bridge": {
        direct: { enabled: false, tools: ["read"] },
        group: { enabled: true, tools: ["read"] },
        actors: [{ kind: "group", platform: "wechat-bridge", conversationId: "room" }],
      },
    },
  };
  const allowed = (platform: string, kind: "direct" | "group", name: string, id = "room", users = ["alice"]) =>
    authorizeTool(
      { conversation: { ...conversation, platform, kind, conversationId: id }, actors: users.map((userId) => ({ platform, userId })) },
      { name, pluginId: "fixture", contexts: ["direct", "group"] },
      value,
    ).allowed;
  expect(allowed("onebot", "direct", "read")).toBe(true);
  expect(allowed("onebot", "group", "read")).toBe(false);
  expect(allowed("onebot", "group", "write")).toBe(true);
  expect(allowed("onebot", "group", "write", "room", ["alice", "bob"])).toBe(false);
  expect(allowed("wechat-bridge", "direct", "read")).toBe(false);
  expect(allowed("wechat-bridge", "group", "read")).toBe(true);
  expect(allowed("wechat-bridge", "group", "write")).toBe(false);
  expect(allowed("wechat-bridge", "group", "read", "other-room", ["bob"])).toBe(true);
  expect(allowed("other", "group", "legacy")).toBe(true);
  value.platforms!.onebot!.actors = [];
  expect(allowed("onebot", "direct", "read", "room", ["bob"])).toBe(true);
  value.platforms!.onebot!.direct.tools = [];
  expect(allowed("onebot", "direct", "legacy")).toBe(false);
});
