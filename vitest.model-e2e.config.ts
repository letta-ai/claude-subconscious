import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // This suite is opted into explicitly. It needs LETTA_API_KEY and spends
    // real model turns, so it must never be picked up by `npm run test:e2e`
    // or the default suite.
    include: [
      "tests/e2e/model-overrides.e2e.test.ts",
      "tests/e2e/local-tools.e2e.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 480_000,
    hookTimeout: 120_000,
  },
});
