import { vi } from "vitest";

import { extension } from "../src/extension.js";

/** Starts the extension with one connection against a fake model registry; returns what it registered. */
export function registerWith(config: Record<string, unknown>, register: (provider: never) => () => void = () => () => undefined) {
  const model = { register: vi.fn(register) };
  const undo = extension.start({ config: extension.parse({ connections: [config] }), core: { model } } as never);
  return { model, undo };
}
