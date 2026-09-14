import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90000,
  workers: 1,
  reporter: "list",
  outputDir: "test-results/e2e",
  use: { trace: "retain-on-failure" },
});
