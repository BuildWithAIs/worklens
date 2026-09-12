import { _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Run after npm run build. Never open the user's actual application data.
const root = await mkdtemp(join(tmpdir(), "worklens-site-capture-"));
const env = { ...process.env, WORKLENS_TEST_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ["."], cwd: resolve("."), env });
try {
  const page = await app.firstWindow();
  await page
    .getByRole("button", { name: "返回对话", exact: true })
    .waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "浅色", exact: true }).click();
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("heading", { name: "新的开始", exact: true }).waitFor();
  await page.screenshot({ path: "website/public/assets/worklens.png" });
} finally {
  await app.close();
}
