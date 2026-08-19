import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    // Each case starts Claude Code and waits for a real turn, so they run one
    // file at a time rather than competing for the same broker.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
