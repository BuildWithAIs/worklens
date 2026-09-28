import { test, expect } from "@playwright/test";
import { mockExistingConversation } from "./fixture.js";

for (const language of ["en", "zh"]) {
  test(`deletion gives immediate feedback, retries and removes locally: ${language}`, async ({
    page,
  }, info) => {
    await mockExistingConversation(page);
    await page.addInitScript((language) => {
      localStorage.setItem("worklens.language", language);
      const state = window as any;
      const invoke = state.worklens.invoke;
      state.deleteCalls = 0;
      state.refreshCalls = 0;
      state.worklens.onChat = (callback: unknown) => {
        state.emitChat = callback;
        return () => {};
      };
      state.worklens.invoke = async (name: string, input: unknown) => {
        if (name === "delete") {
          state.deleteCalls++;
          return new Promise((resolve, reject) => {
            state.finishDelete = resolve;
            state.failDelete = () => reject(new Error("Fixture delete failed"));
          });
        }
        const result = await invoke(name, input);
        if (name === "bootstrap" && state.deleteCalls) {
          state.refreshCalls++;
          // Deliberately return a stale list, after a separately controlled delay.
          return new Promise((resolve) => {
            state.finishRefresh = () => resolve(result);
          });
        }
        return result;
      };
    }, language);
    await page.goto("/");
    const zh = language === "zh";
    await expect(
      page.getByRole("button", { name: "Existing conversation", exact: true }),
    ).toBeVisible();
    await page.evaluate(
      (theme) => {
        document.documentElement.dataset.theme = theme;
      },
      zh ? "dark" : "light",
    );
    await page
      .getByRole("button", {
        name: `${zh ? "会话选项：" : "Conversation options: "}Existing conversation`,
        exact: true,
      })
      .click();
    await page
      .getByRole("menuitem", { name: zh ? "删除" : "Delete", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: zh ? "删除会话？" : "Delete conversation?",
    });
    const remove = dialog.getByRole("button", {
      name: zh ? "删除" : "Delete",
      exact: true,
    });
    await remove.click();
    const pending = dialog.getByRole("button", {
      name: zh ? "删除中…" : "Deleting…",
      exact: true,
    });
    await expect(pending).toBeDisabled();
    await expect(pending).toHaveAttribute("aria-busy", "true");
    await expect(pending.locator("svg")).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: zh ? "取消" : "Cancel", exact: true }),
    ).toBeDisabled();
    await pending.evaluate((button: HTMLButtonElement) => button.click());
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await page.mouse.click(10, 10);
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => (window as any).deleteCalls)).toBe(1);
    await expect(page.locator(".conversation-open")).toHaveCount(1);
    await page.screenshot({
      path: info.outputPath(`deleting-${language}.png`),
    });

    await page.evaluate(() => (window as any).failDelete());
    await expect(remove).toBeEnabled();
    await expect(remove).toHaveAttribute("aria-busy", "false");
    await expect(
      page
        .locator('[data-slot="toast-title"]')
        .filter({ hasText: "Fixture delete failed" }),
    ).toBeVisible();
    await expect(page.locator(".conversation-open")).toHaveCount(1);
    expect(await page.evaluate(() => (window as any).refreshCalls)).toBe(0);

    await remove.click();
    await expect(pending).toBeVisible();
    await page.evaluate(() => (window as any).finishDelete());
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".conversation-open")).toHaveCount(0);
    await expect(
      page.getByRole("heading", {
        name: zh ? "从哪里开始？" : "Where shall we start?",
      }),
    ).toBeVisible();
    expect(await page.evaluate(() => (window as any).deleteCalls)).toBe(2);
    await expect
      .poll(() => page.evaluate(() => (window as any).refreshCalls))
      .toBe(1);

    // Neither delayed history refresh nor an old run event may restore the row.
    await page.evaluate(() => {
      const state = window as any;
      state.finishRefresh();
      state.emitChat({
        conversationId: "existing",
        runId: "old-run",
        sequence: 999,
        type: "run_end",
        view: {
          id: "existing",
          title: "Existing conversation",
          phase: "completed",
          messages: [],
          updatedAt: "2026-09-13T00:00:00Z",
        },
      });
    });
    await expect(page.locator(".conversation-open")).toHaveCount(0);
  });
}
