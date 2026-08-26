import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/opencode.e2e.test.ts"],
    fileParallelism: false,
    testTimeout: 480_000,
    hookTimeout: 120_000,
  },
});
