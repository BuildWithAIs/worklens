import { test, expect, type Page } from "@playwright/test";
import { mockWorklens } from "./fixture.js";
import { pngHeader } from "../image-fixtures";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGNoCX0HRwzEcQDdEhxxGEJJKQAAAABJRU5ErkJggg==";
const file = (name = "screenshot.png") => ({
  name,
  mimeType: "image/png",
  buffer: Buffer.from(png, "base64"),
});
async function setup(
  page: Page,
  options = { fail: false, vision: true, language: "en", theme: "light" },
) {
  await mockWorklens(page);
  await page.addInitScript(
    ({ png, options }) => {
      localStorage.setItem("worklens.language", options.language);
      const invoke = window.worklens.invoke;
      let fail = options.fail;
      let view: any;
      (window as any).imageSends = [];
      (window as any).imageReads = 0;
      window.worklens.invoke = (async (name: string, input: any) => {
        if (name === "send") {
          (window as any).imageSends.push(input);
          if (fail) {
            fail = false;
            throw new Error("CHAT_IMAGE_PROCESSING");
          }
          view = {
            id: "image-session",
            title: "Image conversation",
            phase: "completed",
            selection: input.selection,
            updatedAt: new Date().toISOString(),
            messages: [
              {
                id: "user-1",
                role: "user",
                text: input.text,
                images: input.images.map((image: any, index: number) => ({
                  name: image.name,
                  mimeType: image.mimeType,
                  messageId: "entry-1",
                  index,
                })),
              },
            ],
          };
          return view;
        }
        if (name === "chatImage") {
          (window as any).imageReads++;
          return `data:image/png;base64,${png}`;
        }
        if (name === "open" && view) return view;
        const result = await (invoke as any)(name, input);
        if (name === "bootstrap") {
          result.settings.theme = options.theme;
          for (const provider of result.providers)
            for (const model of provider.models) model.image = options.vision;
        }
        if (name === "settings") result.theme = options.theme;
        return result;
      }) as typeof window.worklens.invoke;
    },
    { png, options },
  );
  await page.goto("/");
}
async function choose(page: Page, files: ReturnType<typeof file>[]) {
  const chosen = page.waitForEvent("filechooser");
  await page.locator(".aui-composer-add-attachment").click();
  await (await chosen).setFiles(files);
  await expect(page.locator(".aui-attachment-tile-uploading")).toHaveCount(0);
}

for (const theme of ["light", "dark"]) {
  test(`multi-image composer wraps, previews, removes and sends image-only (${theme})`, async ({
    page,
  }, info) => {
    await setup(page, {
      fail: false,
      vision: true,
      language: theme === "dark" ? "zh" : "en",
      theme,
    });
    await choose(
      page,
      Array.from({ length: 7 }, (_, index) => file(`image-${index}.png`)),
    );
    const attachments = page.locator(
      ".aui-composer-attachments .aui-attachment-root",
    );
    await expect(attachments).toHaveCount(7);
    await expect(
      page.locator(".aui-composer-attachments img").first(),
    ).toHaveJSProperty("naturalWidth", 4);
    const row = page.locator(".aui-composer-attachments");
    expect(
      await row.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`image-composer-${theme}.png`),
    });
    await page.setViewportSize({ width: 850, height: 620 });
    expect(
      await row.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await expect(page.locator(".aui-composer-input")).toBeInViewport();
    await page.screenshot({
      path: info.outputPath(`image-composer-narrow-${theme}.png`),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    const preview = attachments.first().locator('[role="button"]');
    await preview.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.locator(".aui-attachment-preview-dialog-content"),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.locator(".aui-attachment-preview-dialog-content"),
    ).toHaveCount(0);
    await attachments.first().locator(".aui-attachment-tile-remove").click();
    await expect(attachments).toHaveCount(6);
    await page.locator(".aui-composer-send").click();
    await expect(
      page.locator(".aui-user-message-attachments-end img"),
    ).toHaveCount(6);
    await expect(page.locator(".aui-user-message-content")).toHaveCount(0);
    await expect(
      page
        .locator(".aui-user-action-bar-root")
        .getByRole("button", { name: /Copy|复制/ }),
    ).toHaveCount(0);
    const sent = await page.evaluate(() => (window as any).imageSends);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("");
    expect(sent[0].images.map((image: any) => image.name)).not.toContain(
      "image-0.png",
    );
    expect(sent[0].images[0].data).toBe(png);
    expect(await page.evaluate(() => (window as any).imageReads)).toBe(6);
  });

  test(`image-only history has no empty bubble and preserves message layout (${theme})`, async ({
    page,
  }, info) => {
    await setup(page, { fail: false, vision: true, language: "en", theme });
    await page.evaluate(() => {
      const invoke = window.worklens.invoke;
      window.worklens.invoke = (async (name: string, input: any) => {
        const result = await (invoke as any)(name, input);
        if (name === "send") {
          result.messages = [
            "",
            " \n\t",
            "Describe the colors",
            "A text-only message",
          ].map((text, index) => ({
            id: `layout-message-${index}`,
            role: "user",
            text,
            createdAt: "2026-09-01T01:00:00Z",
            images:
              index < 3
                ? [
                    {
                      name: "color-sample.png",
                      mimeType: "image/png",
                      messageId: `layout-entry-${index}`,
                      index: 0,
                    },
                  ]
                : [],
          }));
        }
        return result;
      }) as typeof window.worklens.invoke;
    });
    await choose(page, [file("color-sample.png")]);
    await page.locator(".aui-composer-send").click();
    const messages = page.locator('[data-slot="aui_user-message-root"]');
    await expect(messages).toHaveCount(4);
    for (const width of [1280, 720]) {
      await page.setViewportSize({ width, height: 1100 });
      for (const index of [0, 1]) {
        const message = messages.nth(index);
        await message.scrollIntoViewIfNeeded();
        await expect(message.locator(".aui-user-message-content")).toHaveCount(
          0,
        );
        const preview = message.locator('.aui-attachment-root [role="button"]');
        await preview.focus();
        await expect(message.locator(".aui-user-action-bar-wrapper")).toHaveCSS(
          "opacity",
          "1",
        );
        await expect(message.locator("time")).toBeVisible();
        const imageBox = await preview.boundingBox();
        const actionBox = await message
          .locator(".aui-user-action-bar-wrapper")
          .boundingBox();
        expect(
          actionBox!.y - imageBox!.y - imageBox!.height,
        ).toBeLessThanOrEqual(12);
        expect(
          Math.abs(
            imageBox!.x + imageBox!.width - actionBox!.x - actionBox!.width,
          ),
        ).toBeLessThanOrEqual(1);
      }
      await expect(
        messages.nth(2).locator(".aui-user-message-content"),
      ).toHaveText("Describe the colors");
      await expect(
        messages.nth(3).locator(".aui-user-message-content"),
      ).toHaveText("A text-only message");
    }
    const preview = messages
      .first()
      .locator('.aui-attachment-root [role="button"]');
    await preview.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.locator(".aui-attachment-preview-dialog-content img"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Previous image", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Next image", exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(preview).toBeFocused();
    await page.screenshot({
      path: info.outputPath(`message-layout-${theme}.png`),
    });
  });
}

test("IPC rejection restores text and images; a retry sends once more", async ({
  page,
}) => {
  await setup(page, {
    fail: true,
    vision: true,
    language: "en",
    theme: "light",
  });
  await choose(page, [file()]);
  await page.locator(".aui-composer-input").fill("Inspect this screenshot");
  await page.locator(".aui-composer-send").click();
  await expect(page.locator(".aui-composer-input")).toHaveValue(
    "Inspect this screenshot",
  );
  await expect(page.locator(".aui-composer-attachments img")).toHaveCount(1);
  await page.locator(".aui-composer-send").click();
  await expect(
    page.locator(".aui-user-message-attachments-end img"),
  ).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).imageSends.length)).toBe(2);
});

for (const theme of ["light", "dark"]) {
  test(`sent images copy individually from menus and previews, while message copy stays text (${theme})`, async ({
    page,
  }, info) => {
    await setup(page, {
      fail: false,
      vision: true,
      language: theme === "dark" ? "zh" : "en",
      theme,
    });
    const originals = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext("2d")!;
      return ["image/png", "image/jpeg", "image/webp"].map((mime, index) => {
        context.fillStyle = ["#336699", "#aa6633", "#669933"][index];
        context.fillRect(0, 0, 640, 360);
        return canvas.toDataURL(mime);
      });
    });
    await page.evaluate((originals) => {
      const invoke = window.worklens.invoke;
      (window as any).originalReads = [];
      (window as any).clipboardImages = [];
      (window as any).clipboardText = [];
      navigator.clipboard.writeText = async (text) => {
        (window as any).clipboardText.push(text);
      };
      navigator.clipboard.write = async (items) => {
        const blob = await items[0].getType("image/png");
        const bitmap = await createImageBitmap(blob);
        (window as any).clipboardImages.push({
          width: bitmap.width,
          height: bitmap.height,
          types: items[0].types,
        });
        bitmap.close();
      };
      window.worklens.invoke = (async (name: string, input: any) => {
        if (name === "chatImage" && input.variant === "original") {
          (window as any).originalReads.push(input.index);
          return originals[input.index];
        }
        return (invoke as any)(name, input);
      }) as typeof window.worklens.invoke;
    }, originals);
    await choose(page, [
      file("sample-a.png"),
      file("sample-b.png"),
      file("sample-c.png"),
    ]);
    await page.locator(".aui-composer-input").fill("Compare these colors");
    await page.locator(".aui-composer-send").click();
    const tiles = page.locator(
      '.aui-user-message-attachments-end .aui-attachment-root [role="button"]',
    );
    const copyLabel = theme === "dark" ? "复制图片" : "Copy image";
    const copiedLabel = theme === "dark" ? "图片已复制" : "Image copied";
    for (let index = 0; index < 3; index++) {
      await tiles.nth(index).click({ button: "right" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      if (index === 0) {
        const menu = page.getByRole("menu");
        const metrics = await menu.evaluate((node) => {
          const row = node.querySelector('[role="menuitem"]')!;
          const style = getComputedStyle(row);
          return {
            width: node.getBoundingClientRect().width,
            rowHeight: row.getBoundingClientRect().height,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            padding: style.padding,
            iconSize: row.querySelector("svg")!.getBoundingClientRect().width,
          };
        });
        expect(metrics.width).toBeLessThan(180);
        expect(metrics).toMatchObject({
          rowHeight: 28,
          fontSize: "14px",
          lineHeight: "20px",
          padding: "4px 8px",
          iconSize: 16,
        });
        await page.screenshot({
          path: info.outputPath(`image-copy-menu-${theme}.png`),
        });
      }
      await expect(
        page.locator(".aui-attachment-preview-dialog-content"),
      ).toHaveCount(0);
      await page
        .getByRole("menuitem", { name: copyLabel, exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => (window as any).clipboardImages.length))
        .toBe(index + 1);
      await expect(
        page
          .locator('[data-slot="toast-title"]')
          .filter({ hasText: copiedLabel })
          .last(),
      ).toBeVisible();
      await expect(page.getByRole("menu")).not.toBeVisible();
      await expect(tiles.nth(index)).toBeFocused();
    }
    expect(await page.evaluate(() => (window as any).originalReads)).toEqual([
      0, 1, 2,
    ]);
    expect(await page.evaluate(() => (window as any).clipboardImages)).toEqual(
      Array.from({ length: 3 }, () => ({
        width: 640,
        height: 360,
        types: ["image/png"],
      })),
    );
    await page.setViewportSize({ width: 720, height: 620 });
    await tiles.first().focus();
    await page.keyboard.press("Shift+F10");
    await expect(
      page.getByRole("menuitem", { name: copyLabel, exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(tiles.first()).toBeFocused();
    await page.keyboard.press("Enter");
    const dialog = page.locator(".aui-attachment-preview-dialog-content");
    await expect(dialog).toBeInViewport({ ratio: 1 });
    await expect(
      dialog.getByRole("button", { name: copyLabel, exact: true }),
    ).toHaveCount(0);
    await expect(dialog.getByRole("status")).toHaveText("1 / 3");
    const previous = dialog.getByRole("button", {
      name: theme === "dark" ? "上一张" : "Previous image",
      exact: true,
    });
    const next = dialog.getByRole("button", {
      name: theme === "dark" ? "下一张" : "Next image",
      exact: true,
    });
    await expect(previous).toBeDisabled();
    await page.keyboard.press("ArrowRight");
    await expect(dialog.getByRole("status")).toHaveText("2 / 3");
    await expect(dialog.locator("img")).toHaveJSProperty("naturalWidth", 640);
    await next.click();
    await expect(dialog.getByRole("status")).toHaveText("3 / 3");
    await expect(next).toBeDisabled();
    await page.keyboard.press("ArrowRight");
    await expect(dialog.getByRole("status")).toHaveText("3 / 3");
    await page.keyboard.press("ArrowLeft");
    await expect(dialog.getByRole("status")).toHaveText("2 / 3");
    await dialog.locator("img").click({ button: "right" });
    await page.getByRole("menuitem", { name: copyLabel, exact: true }).click();
    await expect(
      page
        .locator('[data-slot="toast-title"]')
        .filter({ hasText: copiedLabel })
        .last(),
    ).toBeVisible();
    await expect(page.getByRole("menu")).not.toBeVisible();
    await expect(dialog).toBeVisible();
    await dialog.locator("img").click({ button: "right" });
    const download = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: theme === "dark" ? "下载图片" : "Download image",
        exact: true,
      })
      .click();
    expect((await download).suggestedFilename()).toBe("sample-b.png");
    await expect(page.getByRole("menu")).not.toBeVisible();
    await expect(dialog).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`image-copy-preview-${theme}.png`),
    });
    await page.setViewportSize({ width: 390, height: 620 });
    await expect(dialog.locator("img")).toBeInViewport({ ratio: 1 });
    await expect(previous).toBeInViewport({ ratio: 1 });
    await expect(next).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: info.outputPath(`image-preview-narrow-${theme}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(tiles.first()).toBeFocused();
    await tiles.last().click();
    await expect(dialog.getByRole("status")).toHaveText("3 / 3");
    await expect(next).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(tiles.last()).toBeFocused();
    const message = page.locator('[data-slot="aui_user-message-root"]');
    await message.hover();
    await message
      .getByRole("button", {
        name: theme === "dark" ? "复制文字" : "Copy text",
        exact: true,
      })
      .click();
    expect(await page.evaluate(() => (window as any).clipboardText)).toEqual([
      "Compare these colors",
    ]);
    expect(
      await page.evaluate(() => (window as any).clipboardImages.length),
    ).toBe(4);
  });
}

test("image download closes the menu and reports read failures with a retryable toast", async ({
  page,
}) => {
  await setup(page);
  await choose(page, [file("sample.png")]);
  await page.locator(".aui-composer-send").click();
  await page.evaluate(() => {
    const invoke = window.worklens.invoke;
    let fail = true;
    window.worklens.invoke = (async (name: string, input: any) => {
      if (name === "chatImage" && input.variant === "original" && fail) {
        fail = false;
        await new Promise((resolve) => setTimeout(resolve, 200));
        throw Error("Fixture original read failure");
      }
      return (invoke as any)(name, input);
    }) as typeof window.worklens.invoke;
  });
  const tile = page.locator(
    '.aui-user-message-attachments-end .aui-attachment-root [role="button"]',
  );
  await tile.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Download image", exact: true })
    .click();
  await expect(page.getByRole("menu")).not.toBeVisible();
  await expect(
    page
      .locator('[data-slot="toast-title"]')
      .filter({ hasText: "Couldn’t download the image. Try again." }),
  ).toHaveCount(1);
  await tile.click({ button: "right" });
  const download = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download image", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe("sample.png");
  await expect(page.getByRole("menu")).not.toBeVisible();
  await expect(tile).toBeFocused();
});

test("image copy reports failures, allows retry and cancels a pending history read on navigation", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    (window as any).imageWrites = 0;
    (window as any).rejectImageCopy = true;
    navigator.clipboard.write = async () => {
      if ((window as any).rejectImageCopy)
        throw new DOMException("Denied", "NotAllowedError");
      (window as any).imageWrites++;
    };
  });
  await choose(page, [file("sample.png")]);
  await page.locator(".aui-composer-send").click();
  const tile = page.locator(
    '.aui-user-message-attachments-end .aui-attachment-root [role="button"]',
  );
  await tile.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy image", exact: true }).click();
  await expect(page.getByRole("menu")).not.toBeVisible();
  await expect(
    page
      .locator('[data-slot="toast-title"]')
      .filter({ hasText: "Couldn’t copy the image. Try again." }),
  ).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).imageWrites)).toBe(0);
  await page.evaluate(() => {
    (window as any).rejectImageCopy = false;
  });
  await tile.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy image", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).imageWrites))
    .toBe(1);
  await page.evaluate(() => {
    const invoke = window.worklens.invoke;
    window.worklens.invoke = (async (name: string, input: any) => {
      if (name === "chatImage" && input.variant === "original") {
        await new Promise<void>((resolve) => {
          (window as any).finishCopyRead = resolve;
        });
      }
      return (invoke as any)(name, input);
    }) as typeof window.worklens.invoke;
  });
  await expect(page.getByRole("menu")).not.toBeVisible();
  await tile.focus();
  await page.keyboard.press("Shift+F10");
  await expect(
    page.getByRole("menuitem", { name: "Copy image", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).not.toBeVisible();
  await expect(tile).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).finishCopyRead))
    .toBe("function");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /New chat/ }).click();
  await page.evaluate(() => (window as any).finishCopyRead());
  await expect
    .poll(() => page.evaluate(() => (window as any).imageReads))
    .toBe(4);
  expect(await page.evaluate(() => (window as any).imageWrites)).toBe(1);
});

for (const [language, theme] of [
  ["en", "light"],
  ["zh", "dark"],
]) {
  test(`image preparation rejection uses a toast and preserves the four-image draft (${language})`, async ({
    page,
  }, info) => {
    await setup(page, { fail: true, vision: true, language, theme });
    await choose(page, [
      file("1.png"),
      file("2.png"),
      file("3.png"),
      file("4.png"),
    ]);
    await page.locator(".aui-composer-input").fill("Explain these four photos");
    await page.locator(".aui-composer-send").click();
    await expect(page.locator('[data-slot="toast-title"]')).toContainText(
      language === "en"
        ? "Couldn’t process this image. Restart WorkLens"
        : "无法处理这张图片，请重启 WorkLens",
    );
    await expect(page.locator(".aui-composer-input")).toHaveValue(
      "Explain these four photos",
    );
    await expect(page.locator(".aui-composer-attachments img")).toHaveCount(4);
    await expect(
      page.locator(".aui-user-message-attachments-end img"),
    ).toHaveCount(0);
    await expect(page.locator(".aui-assistant-message-root")).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("image-processing-toast.png"),
    });
    await page.locator(".aui-composer-send").click();
    await expect(
      page.locator(".aui-user-message-attachments-end img"),
    ).toHaveCount(4);
  });
}

for (const withImage of [false, true]) {
  test(`pending submission locks editing and restores the rejected ${withImage ? "image" : "text"} draft`, async ({
    page,
  }) => {
    await setup(page, {
      fail: true,
      vision: true,
      language: "en",
      theme: "light",
    });
    await page.evaluate(() => {
      const invoke = window.worklens.invoke;
      window.worklens.invoke = (async (name: string, input: any) => {
        if (name === "send")
          await new Promise<void>((resolve) => {
            (window as any).releaseImageSend = resolve;
          });
        return (invoke as any)(name, input);
      }) as typeof window.worklens.invoke;
    });
    if (withImage) await choose(page, [file("original.png")]);
    const input = page.locator(".aui-composer-input");
    await input.fill("Original draft");
    await input.press("Enter");
    await expect(input).toBeDisabled();
    await expect(page.locator(".aui-composer-add-attachment")).toBeDisabled();
    await page.keyboard.type("Unsent follow-up");
    await expect(input).toHaveValue("");
    await page
      .locator('[data-slot="aui_composer-shell"]')
      .evaluate((node, png) => {
        const data = new DataTransfer();
        data.items.add(
          new File(
            [Uint8Array.from(atob(png), (char) => char.charCodeAt(0))],
            "late-drop.png",
            { type: "image/png" },
          ),
        );
        const event = new DragEvent("drop", {
          dataTransfer: data,
          bubbles: true,
          cancelable: true,
        });
        node.dispatchEvent(event);
        if (!event.defaultPrevented)
          throw new Error("Disabled drop could navigate away");
        node.querySelector("textarea")!.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: data,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, png);
    await expect(page.locator(".aui-composer-attachments img")).toHaveCount(0);
    await page.evaluate(() => (window as any).releaseImageSend());
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("Original draft");
    await expect(page.locator(".aui-composer-attachments img")).toHaveCount(
      withImage ? 1 : 0,
    );
    await expect(page.locator(".aui-composer-add-attachment")).toBeEnabled();
    await expect(page.locator(".aui-composer-send")).toBeEnabled();
    // A retry is still a single submission and carries exactly the original draft.
    await page.locator(".aui-composer-send").click();
    await expect(input).toBeDisabled();
    await page.evaluate(() => (window as any).releaseImageSend());
    await expect
      .poll(() => page.evaluate(() => (window as any).imageSends.length))
      .toBe(2);
    const sent = await page.evaluate(() => (window as any).imageSends[1]);
    expect(sent.text).toBe("Original draft");
    expect(sent.images.map((image: any) => image.name)).toEqual(
      withImage ? ["original.png"] : [],
    );
  });
}

test("run-start unlocks editing and Stop even before the send reply arrives", async ({
  page,
}) => {
  await setup(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    let listener: Parameters<typeof window.worklens.onChat>[0] | undefined;
    const selection = {
      provider: "deepseek",
      model: "flash",
      thinking: "medium",
    };
    let view: any = {
      id: "running-image-session",
      title: "Existing image conversation",
      phase: "completed",
      updatedAt: new Date().toISOString(),
      selection,
      messages: [],
    };
    window.worklens.onChat = (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    };
    window.worklens.invoke = (async (name: string, input: any) => {
      if (name === "open") return view;
      if (name === "send") {
        await new Promise<void>((resolve) => {
          (window as any).acceptImageSend = () => {
            view = {
              ...view,
              phase: "generating",
              runId: "image-run",
              revision: 1,
              messages: [{ id: "user-1", role: "user", text: input.text }],
            };
            listener?.({
              conversationId: view.id,
              runId: view.runId,
              sequence: 1,
              type: "run_start",
              view,
            });
            (window as any).replyToImageSend = resolve;
          };
        });
        return view;
      }
      if (name === "cancel") {
        (window as any).cancelledImageRun = input;
        view = { ...view, phase: "cancelled", revision: 2 };
        listener?.({
          conversationId: view.id,
          runId: view.runId,
          sequence: 2,
          type: "run_end",
          view,
        });
        return;
      }
      if (name === "settings" && input.lastConversation) {
        await new Promise<void>((resolve) => {
          (window as any).releaseImageSettings = resolve;
        });
      }
      const result = await (invoke as any)(name, input);
      if (name === "bootstrap") {
        result.conversations = [view];
        result.settings.lastConversation = view.id;
      }
      return result;
    }) as typeof window.worklens.invoke;
  });
  await page.reload();
  const input = page.locator(".aui-composer-input");
  await input.fill("Start a task");
  await input.press("Enter");
  await expect(input).toBeDisabled();
  await page.evaluate(() => (window as any).acceptImageSend());
  await expect(input).toBeEnabled();
  await expect(page.locator(".aui-composer-cancel")).toBeEnabled();
  await input.fill("Keep this follow-up");
  await choose(page, [file("follow-up.png")]);
  await page.locator(".aui-composer-cancel").click();
  expect(await page.evaluate(() => (window as any).cancelledImageRun)).toEqual({
    conversationId: "running-image-session",
    runId: "image-run",
  });
  await expect(input).toBeEnabled();
  await page.evaluate(() => (window as any).replyToImageSend());
  // An unrelated settings save must not prolong the submission lock.
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("Keep this follow-up");
  await expect(page.locator(".aui-composer-attachments img")).toHaveCount(1);
  await page.evaluate(() => (window as any).releaseImageSettings());
});

test("pasted and dropped images share validation; the ninth image is rejected", async ({
  page,
}) => {
  await setup(page);
  await page.locator(".aui-composer-input").evaluate((node, png) => {
    const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, png);
  await expect(page.locator(".aui-composer-attachments img")).toHaveCount(1);
  await page
    .locator('[data-slot="aui_composer-shell"]')
    .evaluate((node, png) => {
      const data = new DataTransfer();
      data.items.add(
        new File(
          [Uint8Array.from(atob(png), (char) => char.charCodeAt(0))],
          "dropped.png",
          { type: "image/png" },
        ),
      );
      node.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, png);
  await expect(page.locator(".aui-composer-attachments img")).toHaveCount(2);
  await choose(
    page,
    Array.from({ length: 7 }, (_, index) => file(`more-${index}.png`)),
  );
  await expect(
    page.locator(".aui-composer-attachments .aui-attachment-root"),
  ).toHaveCount(8);
  await expect(
    page.getByRole("alert").filter({
      hasText:
        "You can add up to 8 images per message. Remove an image and try again.",
    }),
  ).toBeVisible();
});

test("unsupported models disable selection and corrupted images cannot be sent", async ({
  page,
}) => {
  await setup(page, {
    fail: false,
    vision: false,
    language: "en",
    theme: "light",
  });
  await expect(page.locator(".aui-composer-add-attachment")).toBeDisabled();
});

test("invalid and oversized files give feedback, keep text and block incomplete attachments", async ({
  page,
}) => {
  await setup(page);
  await page.locator(".aui-composer-input").fill("Keep my draft");
  await choose(page, [{ ...file(), buffer: Buffer.from("not an image") }]);
  await expect(page.locator(".aui-attachment-tile-error")).toHaveCount(1);
  await expect(page.locator(".aui-composer-send")).toBeDisabled();
  await expect(page.locator(".aui-composer-input")).toHaveValue(
    "Keep my draft",
  );
  await page.locator(".aui-attachment-tile-remove").click();
  await choose(page, [
    { ...file(), buffer: Buffer.alloc(5 * 1024 * 1024 + 1) },
  ]);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Each image must be 5 MiB or smaller." }),
  ).toBeVisible();
  await expect(
    page.locator(".aui-composer-attachments .aui-attachment-root"),
  ).toHaveCount(0);
});

test("an unavailable historical preview can be retried with the keyboard", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const invoke = window.worklens.invoke;
    let fail = true;
    window.worklens.invoke = (async (name: string, input: any) => {
      if (name === "chatImage" && fail) {
        fail = false;
        throw new Error("CHAT_IMAGE_MISSING");
      }
      return (invoke as any)(name, input);
    }) as typeof window.worklens.invoke;
  });
  await choose(page, [file()]);
  await page.locator(".aui-composer-send").click();
  const retry = page.getByRole("button", {
    name: "Reload image preview",
    exact: true,
  });
  await expect(retry).toBeVisible();
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.locator(".aui-user-message-attachments-end img"),
  ).toHaveJSProperty("naturalWidth", 4);
});

test("large declared dimensions are rejected before decoding or preview IPC", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    (window as any).imagePreparationCalls = 0;
    const invoke = window.worklens.invoke;
    window.worklens.invoke = (async (name: string, input: any) => {
      if (name === "prepareChatImage") (window as any).imagePreparationCalls++;
      return (invoke as any)(name, input);
    }) as typeof window.worklens.invoke;
    window.createImageBitmap = () => {
      throw new Error("Renderer must not decode uploads");
    };
  });
  await page.locator(".aui-composer-input").fill("Keep this draft");
  await choose(page, [
    {
      name: "synthetic-large-header.png",
      mimeType: "image/png",
      buffer: pngHeader(10000, 10000),
    },
  ]);
  await expect(
    page.getByRole("alert").filter({ hasText: "25 megapixels" }),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).imagePreparationCalls)).toBe(
    0,
  );
  await expect(page.locator(".aui-composer-input")).toHaveValue(
    "Keep this draft",
  );
  await expect(page.locator(".aui-composer-attachments img")).toHaveCount(0);
});

test("history loads nearby thumbnails only and releases Blob URLs when scrolling or leaving", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate((png) => {
    const invoke = window.worklens.invoke;
    const urls = new Set<string>();
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      urls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      urls.delete(url);
      revoke(url);
    };
    (window as any).previewUrls = urls;
    (window as any).previewReads = [];
    window.worklens.invoke = (async (name: string, input: any) => {
      if (name === "chatImage") {
        (window as any).previewReads.push(input);
        return `data:image/png;base64,${png}`;
      }
      if (name === "send")
        return {
          id: "long-image-history",
          title: "Synthetic history",
          phase: "completed",
          selection: input.selection,
          updatedAt: new Date().toISOString(),
          messages: Array.from({ length: 40 }, (_, index) => ({
            id: `message-${index}`,
            role: "user",
            text: `Synthetic message ${index}`,
            images: [
              {
                name: `sample-${index}.png`,
                mimeType: "image/png",
                messageId: `entry-${index}`,
                index: 0,
              },
            ],
          })),
        };
      return (invoke as any)(name, input);
    }) as typeof window.worklens.invoke;
  }, png);
  await page.locator(".aui-composer-input").fill("Open synthetic history");
  await page.locator(".aui-composer-send").click();
  const loaded = page.locator(
    '.aui-user-message-attachments-end img[src^="blob:"]',
  );
  await expect(loaded.first()).toBeVisible();
  const initial = await page.evaluate(() => ({
    reads: (window as any).previewReads,
    urls: (window as any).previewUrls.size,
  }));
  expect(initial.reads.length).toBeLessThan(15);
  expect(initial.reads.every((read: any) => read.variant === "thumbnail")).toBe(
    true,
  );
  expect(initial.urls).toBeLessThan(15);
  const viewport = page.locator('[data-slot="aui_thread-viewport"]');
  await viewport.evaluate((element) => {
    element.scrollTo({ top: 0, behavior: "instant" });
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).previewReads.some(
          (read: any) => read.messageId === "entry-0",
        ),
      ),
    )
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => (window as any).previewUrls.size))
    .toBeLessThan(15);
  const tile = page
    .locator(".aui-user-message-attachments-end .aui-attachment-root")
    .first();
  await tile.locator('[role="button"]').click();
  await expect(
    page.locator(".aui-attachment-preview-dialog-content img"),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as any).previewReads.filter(
          (read: any) => read.variant === "original",
        ).length,
    ),
  ).toBe(1);
  const during = await page.evaluate(() => (window as any).previewUrls.size);
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => (window as any).previewUrls.size))
    .toBeLessThan(during);
  await page.getByRole("button", { name: /New chat/ }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).previewUrls.size))
    .toBe(0);
});

test("late history reads cannot retain URLs after switching conversations", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const invoke = window.worklens.invoke;
    (window as any).lateReads = [];
    (window as any).createdPreviewUrls = 0;
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      (window as any).createdPreviewUrls++;
      return create(blob);
    };
    window.worklens.invoke = (async (name: string, input: any) => {
      if (name === "chatImage")
        return new Promise<string>((resolve) =>
          (window as any).lateReads.push(resolve),
        );
      return (invoke as any)(name, input);
    }) as typeof window.worklens.invoke;
  });
  await choose(page, [file()]);
  await page.locator(".aui-composer-send").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).lateReads.length))
    .toBe(1);
  await page.getByRole("button", { name: /New chat/ }).click();
  await page.evaluate((png) => {
    for (const resolve of (window as any).lateReads)
      resolve(`data:image/png;base64,${png}`);
  }, png);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  expect(await page.evaluate(() => (window as any).createdPreviewUrls)).toBe(0);
});
