import type { PanelPayload } from "../../../src/shared/panel";

export type SetupStepId = "runtime" | "model";

export interface SetupStep {
  id: SetupStepId;
  title: string;
  description: string;
  /** Later steps stay locked until a required step is done. */
  required: boolean;
  done: boolean;
}

interface SetupSession {
  role: "owner" | "member";
  memberRuntime: "running" | "unavailable" | "";
}

const MODEL_STEP = { title: "连接模型服务", description: "填写模型服务的地址和密钥，并选择用来回复的模型。" };

/** Optional steps now use the same editors as ordinary settings. */
export function optionalSetupLink(step: string): string | undefined {
  return ({ adapter: "/settings/platforms", role: "/?panel=files&document=role", channels: "/settings/platforms?section=scope" } as Record<string, string>)[
    step
  ];
}

/**
 * Wizard steps derived only from server state, so a refresh or another device resumes at the same place.
 * Before a member's runtime runs, the panel is unavailable and the remaining steps are shown as pending.
 */
export function setupSteps(session: SetupSession, panel: PanelPayload | undefined): SetupStep[] {
  const steps: SetupStep[] = [];
  if (session.role === "member" && session.memberRuntime)
    steps.push({
      id: "runtime",
      title: "启动机器人",
      description: "启动你的专属机器人；QQ、微信和电脑可以分别接入。",
      required: true,
      done: session.memberRuntime === "running",
    });
  // Web chat needs a model. Platform accounts, roles and reply ranges can be chosen later.
  const model = panel?.onboarding.steps.find((step) => step.id === "model");
  steps.push({ id: "model", ...MODEL_STEP, required: false, done: model?.done ?? false });
  return steps;
}

/** A required step is still open: members are sent to the wizard once per session. */
export function needsSetup(session: SetupSession, panel: PanelPayload | undefined): boolean {
  return setupSteps(session, panel).some((step) => step.required && !step.done);
}
