import { configureLogging, parseConfig, type LogRecord } from "@yesimbot/foundation";
import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({ generateText: vi.fn() }));

import { ModelStickerClassifier } from "../src/classifier.js";
import { moduleConfig } from "../src/config.js";

const input = { bytes: new Uint8Array([1]), mediaType: "image/png", categories: ["猫猫"] };

function harness(imageInput = true) {
  const model = {};
  const resolveAuxiliaryModel = vi.fn(() => ({ model, entry: { modalities: { input: imageInput ? ["text", "image"] : ["text"] } } }));
  const resolveChatModel = vi.fn();
  const records: LogRecord[] = [];
  configureLogging({ sink: (record) => records.push(record) });
  const classifier = new ModelStickerClassifier(resolveAuxiliaryModel as never, parseConfig(moduleConfig, {}));
  return { classifier, model, resolveAuxiliaryModel, resolveChatModel, records };
}

afterEach(() => vi.clearAllMocks());

describe("sticker classification model routing", () => {
  it("uses the core auxiliary model for administrator classification", async () => {
    vi.mocked(generateText).mockResolvedValue({ text: "猫猫" } as never);
    const value = harness();

    await expect(value.classifier.classify(input)).resolves.toEqual({ category: "猫猫", tags: [] });
    expect(value.resolveAuxiliaryModel).toHaveBeenCalledOnce();
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({ model: value.model }));
    expect(value.resolveChatModel).not.toHaveBeenCalled();
  });

  it("leaves classification unavailable when the auxiliary model cannot resolve", async () => {
    const value = harness();
    value.resolveAuxiliaryModel.mockImplementation(() => {
      throw new Error("unavailable");
    });

    await expect(value.classifier.classify(input)).resolves.toBeUndefined();
    expect(generateText).not.toHaveBeenCalled();
    expect(value.resolveChatModel).not.toHaveBeenCalled();
    expect(value.records).toContainEqual(
      expect.objectContaining({ level: "warn", event: "sticker_classifier.model_unavailable", route: "auxiliary", purpose: "utility" }),
    );
  });

  it("requires image input on the auxiliary model without falling back to the chat model", async () => {
    const value = harness(false);

    await expect(value.classifier.classify(input)).resolves.toBeUndefined();
    expect(value.resolveAuxiliaryModel).toHaveBeenCalledOnce();
    expect(generateText).not.toHaveBeenCalled();
    expect(value.resolveChatModel).not.toHaveBeenCalled();
  });
});
