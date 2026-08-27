import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Opt-in Cloud suite. It creates and deletes a disposable Cloud agent and
    // requires a credited Letta API key.
    include: ["tests/e2e/letta-code-cloud-queue.e2e.test.ts"],
    env: { SUBCONSCIOUS_LETTA_CLOUD_QUEUE_LIVE: "1" },
    fileParallelism: false,
    testTimeout: 480_000,
    hookTimeout: 240_000,
  },
});
