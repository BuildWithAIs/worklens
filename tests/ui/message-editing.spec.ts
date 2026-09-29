import { test, expect, type Page } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGNoCX0HRwzEcQDdEhxxGEJJKQAAAABJRU5ErkJggg==";
async function setup(page: Page, theme = "light", imageOnly = false) {
  await mockWorklens(page);
  await page.addInitScript(
    ({ png, theme, imageOnly }) => {
      const invoke = window.worklens.invoke;
      let current: any;
      const view = (version: number) => ({
        id: "editable-chat",
        title: "Synthetic image review",
        branchId: `branch-${version}`,
        phase: "completed",
        updatedAt: new Date().toISOString(),
        selection: { provider: "deepseek", model: "flash", thinking: "medium" },
        messages: [
          {
            id: `user-${version}`,
            entryId: `user-${version}`,
            role: "user",
            text: version
              ? "Revised description"
              : imageOnly
                ? ""
                : "Original description",
            versions:
              version || (window as any).hasRevision
                ? ["user-0", "user-1"]
                : undefined,
            images: [
              {
                name: version ? "replacement.png" : "sample.png",
                mimeType: "image/png",
                messageId: `user-${version}`,
                index: 1,
              },
            ],
          },
          {
            id: `reply-${version}`,
            role: "assistant",
            text: version ? "Revised answer" : "Original answer",
          },
        ],
      });
      (window as any).editRequests = [];
      (window as any).versionRequests = [];
      window.worklens.invoke = (async (name: string, input: any) => {
        if (name === "send") {
          current = view(0);
          return current;
        }
        if (name === "open") return current;
        if (name === "chatImage" || name === "prepareChatImage")
          return `data:image/png;base64,${png}`;
        if (name === "editMessage") {
          (window as any).editRequests.push(input);
          if ((window as any).rejectEdit)
            throw new Error("Synthetic edit rejected");
          if ((window as any).holdEdit)
            await new Promise<void>((resolve) => {
              (window as any).finishEdit = resolve;
            });
          (window as any).hasRevision = true;
          current = view(1);
          return current;
        }
        if (name === "selectMessageVersion") {
          (window as any).versionRequests.push(input);
          current = view(input.targetId === "user-0" ? 0 : 1);
          return current;
        }
        const result = await (invoke as any)(name, input);
        if (name === "bootstrap") {
          result.settings.theme = theme;
          for (const provider of result.providers)
            for (const model of provider.models) model.image = true;
        }
        if (name === "settings") result.theme = theme;
        return result;
      }) as typeof window.worklens.invoke;
    },
    { png, theme, imageOnly },
  );
  await page.goto("/");
  await page
    .locator(".aui-composer-input")
    .fill("Start synthetic conversation");
  await page.locator(".aui-composer-send").click();
}

for (const theme of ["light", "dark"])
  test(`inline text and image editing preserves the bottom draft and switches complete versions (${theme})`, async ({
    page,
  }, info) => {
    await setup(page, theme);
    const draft = page.locator(".aui-composer-input");
    await draft.fill("Unsent follow-up");
    await page.locator('[data-slot="aui_user-message-root"]').first().hover();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.locator(".aui-edit-composer-root");
    await expect(editor.locator(".aui-edit-composer-input")).toHaveValue(
      "Original description",
    );
    await expect(editor.locator("img")).toHaveCount(1);
    await expect(draft).toHaveValue("Unsent follow-up");
    await expect(page.locator(".aui-composer-send")).toBeDisabled();
    await editor.locator(".aui-edit-composer-input").fill("Discarded change");
    await editor.locator(".aui-edit-composer-input").press("Escape");
    await expect(
      page.getByRole("button", { name: "Edit", exact: true }),
    ).toBeFocused();
    await expect(
      page.getByText("Original description", { exact: true }),
    ).toBeVisible();
    await page.locator('[data-slot="aui_user-message-root"]').first().hover();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await editor
      .locator(".aui-edit-composer-input")
      .fill("Revised description");
    await editor
      .getByRole("button", { name: "Remove attachment", exact: true })
      .click();
    const chooser = page.waitForEvent("filechooser");
    await editor.locator(".aui-composer-add-attachment").click();
    await (
      await chooser
    ).setFiles({
      name: "replacement.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
    await expect(editor.locator(".aui-attachment-tile-uploading")).toHaveCount(
      0,
    );
    await page.setViewportSize({ width: 720, height: 850 });
    await expect(editor).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: info.outputPath(`inline-editor-${theme}.png`),
    });
    await editor.getByRole("button", { name: "Save and regenerate" }).click();
    await expect(editor).toHaveCount(0);
    await expect(
      page.getByText("Revised answer", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Original answer", { exact: true }),
    ).toHaveCount(0);
    await expect(draft).toHaveValue("Unsent follow-up");
    const request = await page.evaluate(() => (window as any).editRequests[0]);
    expect(request).toMatchObject({
      messageId: "user-0",
      expectedBranchId: "branch-0",
      text: "Revised description",
      images: [{ name: "replacement.png", data: png }],
    });
    await expect(page.locator(".aui-branch-picker-state")).toHaveText("2 / 2");
    await page
      .getByRole("button", { name: "Previous version", exact: true })
      .click();
    await expect(
      page.getByText("Original answer", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".aui-branch-picker-state")).toHaveText("1 / 2");
    await page
      .getByRole("button", { name: "Next version", exact: true })
      .click();
    await expect(
      page.getByText("Revised answer", { exact: true }),
    ).toBeVisible();
    await expect(draft).toHaveValue("Unsent follow-up");
  });

test("image-only edits keep existing references and restore their draft after a rejected save", async ({
  page,
}) => {
  await setup(page, "light", true);
  await page.locator('[data-slot="aui_user-message-root"]').first().hover();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.locator(".aui-edit-composer-root");
  const input = editor.locator(".aui-edit-composer-input");
  await expect(input).toHaveValue("");
  await page.evaluate(() => {
    (window as any).rejectEdit = true;
  });
  await input.fill("Retry this description");
  await editor.getByRole("button", { name: "Save and regenerate" }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "Synthetic edit rejected",
  );
  await expect(input).toHaveValue("Retry this description");
  await expect(editor.locator("img")).toHaveCount(1);
  expect(
    await page.evaluate(() => (window as any).editRequests[0].images),
  ).toEqual([{ existingIndex: 1 }]);
  await page.evaluate(() => {
    (window as any).rejectEdit = false;
    (window as any).holdEdit = true;
  });
  await editor.getByRole("button", { name: "Save and regenerate" }).click();
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue("Retry this description");
  await expect(editor.locator("img")).toHaveCount(1);
  await expect(
    editor.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => (window as any).finishEdit());
  await expect(editor).toHaveCount(0);
});
