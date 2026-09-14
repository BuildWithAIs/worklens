import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("window restores page scale and disables zoom without removing window controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-zoom-"));
  const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: ["."],
    cwd: resolve("."),
    env: env as Record<string, string>,
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator(".sidebar-toggle")).toBeVisible();
    const zoom = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
      );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomLevel(-0.5),
    );
    expect(await zoom()).toBeLessThan(1);
    await page.reload();
    await expect.poll(zoom).toBe(1);
    await expect(page.locator(".sidebar-toggle")).toBeVisible();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    for (const key of ["-", "=", "Shift+=", "0"]) {
      await page.keyboard.press(`${modifier}+${key}`);
      expect(await zoom()).toBe(1);
    }
    const roles = await app.evaluate(({ Menu }) => {
      const result: string[] = [];
      const visit = (menu: Electron.Menu) => {
        for (const item of menu.items) {
          if (!item.visible || !item.enabled) continue;
          if (item.role) result.push(item.role);
          if (item.submenu) visit(item.submenu);
        }
      };
      const menu = Menu.getApplicationMenu();
      if (menu) visit(menu);
      return result;
    });
    for (const role of ["resetzoom", "zoomin", "zoomout"])
      expect(roles).not.toContain(role);
    expect(roles).toContain("togglefullscreen");
    expect(roles).toContain("minimize");
  } finally {
    await app.close();
  }
});
