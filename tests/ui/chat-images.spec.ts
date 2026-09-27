import { test, expect, type Page } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

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
            throw new Error("Fixture rejected submission");
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
    const sent = await page.evaluate(() => (window as any).imageSends);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("");
    expect(sent[0].images.map((image: any) => image.name)).not.toContain(
      "image-0.png",
    );
    expect(sent[0].images[0].data).toBe(png);
    expect(await page.evaluate(() => (window as any).imageReads)).toBe(6);
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
    page
      .getByRole("alert")
      .filter({ hasText: "Attach up to 8 images, each up to 5 MiB." }),
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
    page.getByRole("alert").filter({ hasText: "Choose an image up to 5 MiB." }),
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
    name: "Retry image preview",
    exact: true,
  });
  await expect(retry).toBeVisible();
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.locator(".aui-user-message-attachments-end img"),
  ).toHaveJSProperty("naturalWidth", 4);
});
