import { defineConfig } from "@playwright/test";
// Local preview traffic must bypass workstation HTTP proxies.
process.env.NO_PROXY = process.env.no_proxy = "localhost,127.0.0.1,::1";
export default defineConfig({
  testDir: "./tests/ui",
  timeout: 45000,
  workers: 1,
  reporter: "list",
  outputDir: "test-results/ui",
  use: {
    channel: "chrome",
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "node node_modules/vite/bin/vite.js preview --outDir dist/renderer --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
