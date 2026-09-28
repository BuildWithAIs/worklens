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
