import { expect, it } from "vitest";

import { editorValue } from "../web/src/lib/editor-value";

it("compares nested JSON objects independently of key order without changing array or missing-value semantics", () => {
  expect(editorValue({ a: 1, b: { x: 2, y: 3 } })).toBe(editorValue({ b: { y: 3, x: 2 }, a: 1 }));
  expect(editorValue({ values: [1, 2] })).not.toBe(editorValue({ values: [2, 1] }));
  expect(editorValue({})).not.toBe(editorValue({ enabled: false }));
  expect(editorValue(undefined)).not.toBe(editorValue(null));
});
