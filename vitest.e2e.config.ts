import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    // Opt-in live suites have their own configs and environment requirements,
    // which the Claude-only run must not inherit.
    exclude: [
      "tests/e2e/model-overrides.e2e.test.ts",
      "tests/e2e/local-tools.e2e.test.ts",
      "tests/e2e/codex.e2e.test.ts",
      "tests/e2e/hermes.e2e.test.ts",
      "tests/e2e/letta-code-cloud-queue.e2e.test.ts",
      "tests/e2e/letta-code-interactive.e2e.test.ts",
      "tests/e2e/letta-code-live.e2e.test.ts",
      "tests/e2e/opencode.e2e.test.ts",
      "tests/e2e/sandbox-observer.e2e.test.ts",
    ],
    // Each case starts Claude Code and waits for a real turn, so they run one
    // file at a time rather than competing for the same broker.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
