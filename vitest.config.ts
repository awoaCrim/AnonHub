import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  // From the repository root every workspace's tests; from a workspace without its own config (`yarn test` runs each
  // one there), that workspace's own `tests/`.
  test: { include: ["{apps/*,core,packages/*,plugins/*,platforms/*,providers/*}/tests/**/*.{test,spec}.{ts,tsx,js}", "tests/**/*.{test,spec}.{ts,tsx,js}"] },
});
