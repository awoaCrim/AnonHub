import { expect, it } from "vitest";

import { authorizeToolCapability, builtinToolCapability, deviceToolCapability, toolCapabilitySchema, type ToolCapability } from "../src/index.js";

const scope = (platform = "onebot", kind: "direct" | "group" = "direct") => ({ conversation: { platform, kind } });
const declaration: ToolCapability = { platforms: ["web", "onebot"], sensitive: false, executionKind: "read" };

it("requires complete tool declarations and exact adapted platforms", () => {
  for (const capability of [
    undefined,
    {},
    { ...declaration, sensitive: undefined },
    { ...declaration, platforms: ["*"] },
    { ...declaration, executionKind: "unknown" },
  ]) {
    expect(authorizeToolCapability(scope(), capability as ToolCapability)).toEqual({ allowed: false, reason: "undeclared-tool" });
  }
  expect(authorizeToolCapability(scope(), declaration)).toEqual({ allowed: true });
  expect(authorizeToolCapability(scope("wechat-bridge"), declaration)).toEqual({ allowed: false, reason: "unsupported-platform" });
  expect(authorizeToolCapability({ conversation: { platform: "onebot", kind: "invalid" as "direct" } }, declaration).allowed).toBe(false);
});

// User, 2026-11-18: 「所有会话都具有所有工具，但是只有系统维护的平台的那个管理员可以调用敏感工具，其他工具不限制」.
it("offers sensitive tools in every conversation and runs them only for admins", () => {
  for (const platform of ["onebot", "wechat-bridge", "web"]) {
    const capability = { ...declaration, platforms: [platform], sensitive: true };
    for (const kind of ["direct", "group"] as const) {
      expect(authorizeToolCapability(scope(platform, kind), capability).allowed).toBe(true);
      expect(authorizeToolCapability({ ...scope(platform, kind), admin: true }, capability).allowed).toBe(true);
      expect(authorizeToolCapability({ ...scope(platform, kind), admin: false }, capability)).toEqual({ allowed: false, reason: "admin-only" });
    }
  }
  // Other tools are not limited.
  expect(authorizeToolCapability({ ...scope("onebot", "group"), admin: false }, declaration).allowed).toBe(true);
});

it("does not let web, extension names or read execution labels bypass platform ownership", () => {
  const qq = builtinToolCapability("yesimbot-onebot-utils", "onebot_create_reaction")!;
  expect(authorizeToolCapability(scope("web"), qq).allowed).toBe(false);
  expect(builtinToolCapability("third-party", "gmail")).toBeUndefined();
  const gmail = builtinToolCapability("yesimbot-google", "gmail")!;
  expect(gmail.executionKind).toBe("read");
  expect(gmail.sensitive).toBe(true);
  expect(authorizeToolCapability(scope("onebot", "group"), gmail).allowed).toBe(true);
  expect(authorizeToolCapability({ ...scope("onebot", "group"), admin: false }, gmail).allowed).toBe(false);
  expect(toolCapabilitySchema.safeParse(qq).success).toBe(true);
});

it("retains platform-only contexts and independent copies of built-in declarations", () => {
  const group = builtinToolCapability("yesimbot-onebot-utils", "onebot_set_essence")!;
  expect(authorizeToolCapability(scope(), group).allowed).toBe(false);
  expect(authorizeToolCapability(scope("onebot", "group"), group).allowed).toBe(true);
  (group.platforms as string[]).push("web");
  expect(builtinToolCapability("yesimbot-onebot-utils", "onebot_set_essence")!.platforms).toEqual(["onebot"]);
});

it("offers the WeChat group roster in WeChat groups to the main conversation only", () => {
  const roster = builtinToolCapability("adapter-wechat-bridge", "wechat_group_members")!;
  expect(roster).toMatchObject({ executionKind: "read", sensitive: false, workers: [] });
  expect(authorizeToolCapability(scope("wechat-bridge", "group"), roster).allowed).toBe(true);
  expect(authorizeToolCapability(scope("wechat-bridge", "direct"), roster).allowed).toBe(false);
  expect(authorizeToolCapability(scope("onebot", "group"), roster).allowed).toBe(false);
  expect(builtinToolCapability("third-party", "wechat_group_members")).toBeUndefined();
});

it("keeps owner library management on the authenticated web direct surface with service-only writes", () => {
  for (const name of ["instance_memory_read", "instance_memory_write"]) {
    const capability = builtinToolCapability("yesimbot-instance-management", name)!;
    expect(capability.executionKind).toBe(/write/.test(name) ? "service" : "read");
    expect(capability.sensitive).toBe(true);
    expect(authorizeToolCapability(scope("web"), capability).allowed).toBe(true);
    expect(authorizeToolCapability(scope("web", "group"), capability).allowed).toBe(false);
    expect(authorizeToolCapability(scope("onebot"), capability).allowed).toBe(false);
    expect(builtinToolCapability("third-party", name)).toBeUndefined();
  }
});

it("keeps device operations sensitive while permitting the native message transport", () => {
  for (const [capability, method] of [
    ["computer.shell", "exec"],
    ["computer.desktop", "ui"],
    ["workspace.files", "read"],
  ]) {
    const device = deviceToolCapability(capability, method, "onebot");
    expect(device?.sensitive).toBe(true);
    expect(authorizeToolCapability({ ...scope("onebot", "group"), admin: false }, device).allowed).toBe(false);
  }
  // WeChat is no longer a device capability: the agent-wechat daemon is a chat platform, not a device transport.
  expect(deviceToolCapability("wechat.send", "send", "wechat-bridge")).toBeUndefined();
  expect(deviceToolCapability("unknown", "execute", "web")).toBeUndefined();
});

it("permits isolated HTML rendering for anyone while keeping files, commands and devices for admins", () => {
  const renderer = builtinToolCapability("yesimbot-workspace", "render_html")!;
  expect(renderer).toMatchObject({ executionKind: "content", sensitive: false });
  expect(authorizeToolCapability({ ...scope("onebot", "group"), admin: false }, renderer).allowed).toBe(true);
  for (const name of ["bash", "readFile", "writeFile", "editFile", "computer_exec", "computer_ui", "computer_switch"]) {
    const capability = builtinToolCapability("yesimbot-workspace", name)!;
    expect(capability.sensitive).toBe(true);
    expect(authorizeToolCapability(scope("onebot", "group"), capability).allowed).toBe(true);
    expect(authorizeToolCapability({ ...scope("onebot", "group"), admin: false }, capability).allowed).toBe(false);
  }
});

it("opens Xiaoheihe reading to everyone and publishing to admins, in every conversation", () => {
  const reads = ["xiaoheihe"];
  const writes = ["xiaoheihe_publish"];
  for (const platform of ["onebot", "wechat-bridge", "web"]) {
    for (const name of reads) {
      const capability = builtinToolCapability("yesimbot-xiaoheihe", name)!;
      expect(capability).toMatchObject({ executionKind: "read", sensitive: false });
      expect(authorizeToolCapability(scope(platform, "direct"), capability).allowed).toBe(true);
      expect(authorizeToolCapability(scope(platform, "group"), capability).allowed).toBe(true);
    }
    for (const name of writes) {
      const capability = builtinToolCapability("yesimbot-xiaoheihe", name)!;
      expect(capability).toMatchObject({ executionKind: "service", sensitive: true });
      expect(authorizeToolCapability(scope(platform, "direct"), capability).allowed).toBe(true);
      expect(authorizeToolCapability({ ...scope(platform, "group"), admin: true }, capability).allowed).toBe(true);
      expect(authorizeToolCapability({ ...scope(platform, "group"), admin: false }, capability)).toEqual({ allowed: false, reason: "admin-only" });
    }
  }
  expect(builtinToolCapability("third-party", "xiaoheihe")).toBeUndefined();
  expect(authorizeToolCapability(scope("xiaoheihe", "direct"), builtinToolCapability("yesimbot-xiaoheihe", "xiaoheihe")!).allowed).toBe(false);
});
