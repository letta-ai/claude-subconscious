import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Opt-in local suite. These files need Letta Code 0.30.32 and a disposable
    // local backend. Cloud queue acceptance has its own credentialed config.
    include: [
      "tests/e2e/letta-code-live.e2e.test.ts",
      "tests/e2e/letta-code-interactive.e2e.test.ts",
    ],
    env: {
      SUBCONSCIOUS_LETTA_CODE_LIVE: "1",
      SUBCONSCIOUS_LETTA_CODE_INTERACTIVE_LIVE: "1",
    },
    fileParallelism: false,
    testTimeout: 480_000,
    hookTimeout: 240_000,
  },
});
