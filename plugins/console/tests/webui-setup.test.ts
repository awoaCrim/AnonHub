import { expect, it } from "vitest";

import type { PanelPayload } from "../src/shared/panel";
import { needsSetup, optionalSetupLink, setupSteps } from "../web/src/pages/setup-model";

const panel = (done: Record<string, boolean>, role = true) =>
  ({
    onboarding: {
      complete: false,
      steps: [
        { id: "adapter", title: "登录 QQ", description: "", target: "", done: !!done.adapter },
        { id: "model", title: "连接模型服务", description: "", target: "", done: !!done.model },
        ...(role ? [{ id: "role", title: "选择角色", description: "", target: "", done: !!done.role }] : []),
        { id: "channels", title: "选择回复范围", description: "", target: "", done: !!done.channels },
      ],
    },
  }) as PanelPayload;
const member = { role: "member" as const, memberRuntime: "running" as const, features: { napcat: true } };

it("derives steps from server state, starting with the member runtime", () => {
  const steps = setupSteps(member, panel({ adapter: true }));
  expect(steps.map((step) => [step.id, step.required, step.done])).toEqual([
    ["runtime", true, true],
    ["model", false, false],
  ]);
  expect(needsSetup(member, panel({ adapter: true }))).toBe(false);
  expect(needsSetup(member, panel({}))).toBe(false);
});

it("shows pending steps before the runtime exists and omits unavailable ones", () => {
  const unavailable = { ...member, memberRuntime: "unavailable" as const };
  expect(setupSteps(unavailable, undefined).map((step) => [step.id, step.done])).toEqual([
    ["runtime", false],
    ["model", false],
  ]);
  // No NapCat: QQ cannot be set up here, so it is not a blocking step.
  const owner = { role: "owner" as const, memberRuntime: "" as const, features: { napcat: false } };
  expect(setupSteps(owner, panel({}, false)).map((step) => step.id)).toEqual(["model"]);
  expect(needsSetup(owner, panel({}, false))).toBe(false);
});

it("keeps optional setup bookmarks linked to the permanent editors", () => {
  expect(optionalSetupLink("adapter")).toBe("/settings/platforms");
  expect(optionalSetupLink("role")).toBe("/?panel=files&document=role");
  expect(optionalSetupLink("channels")).toBe("/settings/platforms?section=scope");
  expect(optionalSetupLink("model")).toBeUndefined();
});
