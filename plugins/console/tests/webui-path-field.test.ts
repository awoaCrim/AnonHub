import { expect, it } from "vitest";

import { branchLabel } from "../web/src/schema/schema-model";

it("names union options", () => {
  const local = { type: "object", dict: { kind: { type: "const", value: "local" }, path: { type: "string" } } };
  expect(branchLabel(local, 0)).toBe("local");
  expect(branchLabel({ type: "const", value: "x", meta: { description: "某项\n说明" } }, 1)).toBe("某项");
  expect(branchLabel({ type: "string" }, 2)).toBe("文本");
  expect(branchLabel({ type: "object", dict: {} }, 3)).toBe("选项 4");
});
