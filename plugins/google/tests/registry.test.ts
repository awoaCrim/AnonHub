import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { errorEntry } from "@yesimbot/foundation";
import { expect, it } from "vitest";

import { GOOGLE_ERRORS } from "../src/errors.js";

const SRC = join(import.meta.dirname, "../src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
  );
}

it("registers every google_* code the plugin throws, with Chinese texts for the model and the user", () => {
  const used = new Set<string>();
  for (const file of sources(SRC))
    for (const match of readFileSync(file, "utf8").matchAll(/(?:googleError|AppError)\(\s*"(google_[a-z_]+)"/g)) used.add(match[1]!);
  // Codes compared by name (`error.code === "google_..."`) must exist too.
  for (const file of sources(SRC)) for (const match of readFileSync(file, "utf8").matchAll(/\.code (?:===|!==) "(google_[a-z_]+)"/g)) used.add(match[1]!);
  const registered = new Set(Object.keys(GOOGLE_ERRORS));
  expect([...used].filter((code) => !registered.has(code))).toEqual([]);
  for (const code of registered) expect(errorEntry(code)).toMatchObject({ model: expect.stringMatching(/[一-鿿]/), user: expect.stringMatching(/[一-鿿]/) });
});
