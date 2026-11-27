import { defineConfig } from "vitest/config";

// Each file boots a whole host; give it time and run files one after another.
export default defineConfig({ test: { root: ".", include: ["tests/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 120_000, fileParallelism: false } });
