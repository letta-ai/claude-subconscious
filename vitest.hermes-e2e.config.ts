import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/hermes.e2e.test.ts"],
    env: { SUBCONSCIOUS_HERMES_LIVE: "1" },
    fileParallelism: false,
    testTimeout: 480_000,
    hookTimeout: 120_000,
  },
});
