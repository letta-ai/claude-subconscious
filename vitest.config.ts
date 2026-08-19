import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The end-to-end suite starts a real Claude Code process and needs an
    // authenticated session, so it runs from `npm run test:e2e` rather than on
    // every check.
    exclude: ["node_modules/**", "dist/**", "tests/e2e/**"],
  },
});
