import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    // Polls wait on real work (mock model runs, child processes), which a
    // busy CI runner can take well over the 1s default to finish.
    expect: { poll: { timeout: 10000 } },
    globalSetup: ["tests/search-worker-setup.ts"],
  },
});
