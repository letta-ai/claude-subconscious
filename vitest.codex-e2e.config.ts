import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // This suite is opted into explicitly. It needs a real `codex` binary
    // and a real Codex login, and it spends real OpenAI turns, so it must
    // never be picked up by `npm run test:e2e` or the default suite.
    include: ["tests/e2e/codex.e2e.test.ts"],
    env: { SUBCONSCIOUS_CODEX_LIVE: "1" },
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
