import { checkConfig, configForm, parseConfig } from "@yesimbot/foundation";
import { describe, expect, it } from "vitest";

import { moduleConfig } from "../src/config.js";
import { MIN_CONTEXT_TRIGGER_TOKENS } from "../src/runtimes/context-policy.js";

type FormNode = {
  title?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  hidden?: boolean;
  group?: string;
  properties?: Record<string, FormNode>;
};

const parse = (raw: unknown) => parseConfig(moduleConfig, raw);
const accepts = (raw: unknown) => checkConfig(moduleConfig.schema, raw).ok;
const form = configForm(moduleConfig.schema) as FormNode;
const field = (...path: string[]) => path.reduce<FormNode | undefined>((node, key) => node?.properties?.[key], form);

describe("Core config", () => {
  it("makes the Magic Context trigger optional, with the same smallest value as at runtime", () => {
    const magic = (magicContext: Record<string, unknown>) => ({
      chatModel: "test:model",
      session: { magicContext },
    });
    expect(parse(magic({})).session.magicContext.triggerTokens).toBeUndefined();
    expect(parse(magic({ triggerTokens: MIN_CONTEXT_TRIGGER_TOKENS })).session.magicContext.triggerTokens).toBe(MIN_CONTEXT_TRIGGER_TOKENS);
    expect(accepts(magic({ triggerTokens: MIN_CONTEXT_TRIGGER_TOKENS - 1 }))).toBe(false);
    expect(accepts(magic({ triggerTokens: 14000.5 }))).toBe(false);
    expect(field("session", "magicContext", "triggerTokens")?.minimum).toBe(MIN_CONTEXT_TRIGGER_TOKENS);
  });

  it("keeps video input opt-in and preserves independent image configuration", () => {
    const old = parse({ chatModel: "test:model", imageInput: true });
    expect(old.videoInput).toBe(false);
    expect(old.imageInput).toBe(true);
    const video = parse({ chatModel: "test:model", videoInput: true, imageInput: false });
    expect(video.videoInput).toBe(true);
    expect(video.imageInput).toBe(false);
  });

  it("keeps session management fields under the 会话管理 field", () => {
    expect(field("session")?.title).toBe("会话管理");
    expect(Object.keys(field("session")?.properties ?? {})).toEqual(["archive", "magicContext"]);
  });

  it("splits the form into the 基础配置 and 模型输入与资源读取 sections", () => {
    expect(field("chatModel")?.group).toBe("基础配置");
    expect(field("modelRetries")?.group).toBe("模型输入与资源读取");
    expect(field("pacing")?.group).toBeUndefined();
  });

  it("no longer exposes a context window; an old config that still has one loads without error", () => {
    expect(field("session", "magicContext")?.title).toBe("Magic Context");
    expect(field("session", "magicContext")?.properties).not.toHaveProperty("contextWindow");
    expect(field("session", "magicContext")?.properties).toHaveProperty("triggerTokens");
    const resolved = parse({ chatModel: "test:model", session: { magicContext: { contextWindow: 147200 } } });
    // The unknown key passes through untouched; nothing reads it (see context-workspace tests).
    expect(resolved.session.magicContext.triggerTokens).toBeUndefined();
  });

  it("does not expose an optional switch for the mandatory role workflow", () => {
    expect(JSON.stringify(form)).not.toContain("preventSelfStyleImitation");
    expect(parse({ chatModel: "test:model" })).not.toHaveProperty("preventSelfStyleImitation");
  });

  it("defaults custom inner thought to disabled", () => {
    expect(parse({ chatModel: "test:model" }).customInnerThought).toBe(false);
  });

  it("defaults main-channel model retries to three and bounds them to zero through five", () => {
    expect(field("modelRetries")).toMatchObject({ default: 3, minimum: 0, maximum: 5 });
    expect(parse({ chatModel: "test:model" }).modelRetries).toBe(3);
    expect(accepts({ modelRetries: 6 })).toBe(false);
  });

  it("defaults only the supported session settings", () => {
    const resolved = parse({ chatModel: "test:model" });
    expect(resolved.session).not.toHaveProperty("compact");
    expect(resolved.session.magicContext).toEqual({});
  });

  it("exposes only the trigger under Magic Context", () => {
    const magic = field("session", "magicContext");
    // History summaries follow the auxiliary model; no section selects one (user, 2026-11-21).
    expect(Object.keys(magic?.properties ?? {})).toEqual(["triggerTokens"]);
    expect(magic?.properties?.triggerTokens?.hidden).not.toBe(true);
  });

  it.each([7999, 1.5, Number.POSITIVE_INFINITY])("validates the active Magic trigger %s", (value) => {
    expect(accepts({ chatModel: "test:main", session: { magicContext: { triggerTokens: value } } })).toBe(false);
  });

  it("fails to start on a config that does not fit, naming the field", () => {
    expect(() => parse({ logLevel: 7 })).toThrow(expect.objectContaining({ code: "config_invalid", detail: expect.stringMatching(/^yesimbot: logLevel /) }));
  });
});
