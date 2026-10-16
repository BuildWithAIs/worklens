import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    globalSetup: ["tests/search-worker-setup.ts"],
  },
});
