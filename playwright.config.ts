import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90000,
  workers: 1,
  reporter: "list",
  outputDir: "test-results",
  use: { trace: "retain-on-failure" },
});
