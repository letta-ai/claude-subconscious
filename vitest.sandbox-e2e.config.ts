import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // This suite is opted into explicitly. It needs DEVELOPERS_API_KEY, opens a
    // real Cloud managed sandbox, and spends a live observer turn, so it must
    // never be picked up by the default suite. Run with:
    // `npx vitest run --config vitest.sandbox-e2e.config.ts`
    include: ["tests/e2e/sandbox-observer.e2e.test.ts"],
    env: { SUBCONSCIOUS_SANDBOX_LIVE: "1" },
    fileParallelism: false,
    testTimeout: 480_000,
    hookTimeout: 120_000,
  },
});
