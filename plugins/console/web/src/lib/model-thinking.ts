import type { ModelSettingsModel } from "../../../src/model-settings-types";
import type { PickerOption } from "./picker";

export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type Level = (typeof MODEL_THINKING_LEVELS)[number];

/** Keep existing extended values/maps visible even on a protocol without native support. */
export function modelThinkingLevels(protocol: string, model: ModelSettingsModel): readonly Level[] {
  return MODEL_THINKING_LEVELS.filter(
    (level) => !extended(level) || nativeExtended(protocol) || model.thinkingLevel === level || Object.hasOwn(model.thinkingLevelMap ?? {}, level),
  );
}

export function modelThinkingOptions(protocol: string, model: ModelSettingsModel): PickerOption<ModelSettingsModel["thinkingLevel"]>[] {
  return [
    { value: undefined, label: "使用协议默认值" },
    ...modelThinkingLevels(protocol, model).map((level) => {
      const mapped = model.thinkingLevelMap?.[level];
      return {
        value: level,
        label: level,
        disabled: extended(level) && (mapped === null || (mapped === undefined ? !nativeExtended(protocol) : !nativeValue(protocol, mapped))),
      };
    }),
  ];
}

/** Only an intentional selection opts this model into a native extended level. */
export function selectModelThinkingLevel(protocol: string, model: ModelSettingsModel, level: ModelSettingsModel["thinkingLevel"]): void {
  model.thinkingLevel = level;
  if (extended(level) && nativeExtended(protocol) && model.thinkingLevelMap?.[level] === undefined) {
    model.thinkingLevelMap = { ...model.thinkingLevelMap, [level]: level };
  }
}

export function modelThinkingHint(protocol: string, model: ModelSettingsModel): string {
  if (!extended(model.thinkingLevel)) return "";
  if (model.reasoning === false) return "此模型未启用推理，思考等级不会生效。";
  const mapped = model.thinkingLevelMap?.[model.thinkingLevel];
  if (mapped === null) return "此模型已将该等级标为不支持。";
  if (mapped === undefined) return "此等级尚未设置映射，将使用可用等级。";
  return nativeValue(protocol, mapped) ? "" : "此协议不支持该映射值。";
}

function extended(level: Level | undefined): level is "xhigh" | "max" {
  return level === "xhigh" || level === "max";
}

function nativeExtended(protocol: string): boolean {
  return ["openai", "anthropic", "deepseek"].includes(protocol);
}

function nativeValue(protocol: string, value: string): boolean {
  if (protocol === "google") return ["minimal", "low", "medium", "high"].includes(value);
  if (protocol === "openai") return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
  return nativeExtended(protocol) && ["low", "medium", "high", "xhigh", "max"].includes(value);
}
