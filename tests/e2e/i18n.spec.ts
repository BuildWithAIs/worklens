import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("actual Electron switches language immediately and restores it after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worklens-i18n-"));
  let application: ElectronApplication | undefined;

  const launch = async () => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      WORKLENS_TEST_ROOT: directory,
    };
    delete environment.ELECTRON_RUN_AS_NODE;
    const instance = await electron.launch({
      args: ["."],
      cwd: resolve("."),
      env: environment as Record<string, string>,
    });
    application = instance;
    const window = await instance.firstWindow();
    await expect(window.locator(".sidebar")).toBeVisible();
    return { instance, window };
  };

  try {
    const first = await launch();
    await expect(first.window.locator("html")).toHaveAttribute("lang", "en");
    await first.window
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await first.window
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("zh");
    await expect(
      first.window.getByRole("combobox", { name: "语言", exact: true }),
    ).toHaveValue("zh");
    await expect(first.window.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(first.window.getByText("偏好", { exact: true })).toBeVisible();
    await first.window
      .getByRole("button", { name: "返回应用", exact: true })
      .click();
    await expect(
      first.window.getByRole("button", { name: "设置", exact: true }),
    ).toBeVisible();
    await first.instance.close();
    application = undefined;

    const second = await launch();
    await expect(second.window.locator("html")).toHaveAttribute(
      "lang",
      "zh-CN",
    );
    await expect(
      second.window.getByRole("button", { name: "设置", exact: true }),
    ).toBeVisible();
    await second.window
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await second.window
      .getByRole("combobox", { name: "语言", exact: true })
      .selectOption("en");
    await expect(
      second.window.getByRole("combobox", { name: "Language", exact: true }),
    ).toHaveValue("en");
    await expect(second.window.locator("html")).toHaveAttribute("lang", "en");
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});
