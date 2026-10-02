import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mockServer, fixtureModel } from "../mock-server";
import sharp from "sharp";
import { imageDimensions } from "../../src/shared/image-dimensions";

test("text-only prompts succeed before and after image history in Electron", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-text-image-e2e-"));
  const server = await mockServer();
  const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env))
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/.test(key))
      delete env[key];
  const app = await electron.launch({
    executablePath: process.env.WORKLENS_PACKAGED_EXE,
    args: process.env.WORKLENS_PACKAGED_EXE ? [] : ["."],
    cwd: resolve("."),
    env: env as Record<string, string>,
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.show();
      window.focus();
    });
    await page.bringToFront();
    await expect(page.locator(".sidebar")).toBeVisible();
    await app.evaluate(
      async ({ app }, { url, model }) => {
        const vm = process.getBuiltinModule("node:vm");
        const uri = process
          .getBuiltinModule("node:url")
          .pathToFileURL(app.getAppPath() + "/dist/main/index.js").href;
        const imported = await vm.runInThisContext(
          `import(${JSON.stringify(uri)})`,
          {
            importModuleDynamically:
              vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
          },
        );
        imported.agents.modelRuntime.registerProvider("worklens-test", {
          api: "openai-completions",
          baseUrl: url,
          apiKey: "fixture",
          models: [{ ...model, input: ["text", "image"] }],
        });
        await imported.agents.modelRuntime.refresh({ allowNetwork: false });
      },
      { url: server.url, model: fixtureModel },
    );
    await page.evaluate(() =>
      window.worklens.invoke("settings", {
        riskAccepted: true,
        defaults: {
          provider: "worklens-test",
          model: "worklens-test",
          thinking: "off",
        },
      }),
    );
    await page.reload();
    const sendText = async (text: string, count: number) => {
      await page.locator(".aui-composer-input").fill(text);
      await page.locator(".aui-composer-send").click();
      await expect.poll(() => server.requests.length).toBe(count);
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const state = await window.worklens.invoke("bootstrap", undefined);
            return (
              await window.worklens.invoke("open", {
                id: state.conversations[0].id,
              })
            ).phase;
          }),
        )
        .toBe("completed");
      await expect(page.locator(".aui-message-error-root")).toHaveCount(0);
    };
    await sendText("A synthetic text question", 1);
    const picture = await sharp({
      create: { width: 32, height: 48, channels: 3, background: "#326789" },
    })
      .png()
      .toBuffer();
    const chooser = page.waitForEvent("filechooser");
    await page.locator(".aui-composer-add-attachment").click();
    await (
      await chooser
    ).setFiles(
      Array.from({ length: 5 }, (_, index) => ({
        name: `sample-${index + 1}.png`,
        mimeType: "image/png",
        buffer: picture,
      })),
    );
    await expect(page.locator(".aui-composer-attachments img")).toHaveCount(5);
    await expect(page.locator(".aui-attachment-tile-uploading")).toHaveCount(0);
    await sendText("Inspect the synthetic pictures", 2);
    await sendText("Summarize the pictures", 3);
    const users = server.requests[2].messages.filter(
      (message: any) => message.role === "user",
    );
    expect(users).toHaveLength(3);
    expect(
      users.flatMap((message: any) =>
        Array.isArray(message.content)
          ? message.content.filter((part: any) => part.type === "image_url")
          : [],
      ),
    ).toHaveLength(5);
    expect(users.at(-1).content).toEqual([
      { type: "text", text: "Summarize the pictures" },
    ]);
  } finally {
    await app.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Electron sends PNG, JPEG and WebP to Pi and reloads previews through validated IPC", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-image-e2e-"));
  const server = await mockServer();
  const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env))
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/.test(key))
      delete env[key];
  const app = await electron.launch({
    executablePath: process.env.WORKLENS_PACKAGED_EXE,
    args: process.env.WORKLENS_PACKAGED_EXE ? [] : ["."],
    cwd: resolve("."),
    env: env as Record<string, string>,
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.show();
      window.focus();
    });
    await page.bringToFront();
    await expect(page.locator(".sidebar")).toBeVisible();
    await app.evaluate(
      async ({ app }, { url, model }) => {
        const vm = process.getBuiltinModule("node:vm");
        const uri = process
          .getBuiltinModule("node:url")
          .pathToFileURL(app.getAppPath() + "/dist/main/index.js").href;
        const imported = await vm.runInThisContext(
          `import(${JSON.stringify(uri)})`,
          {
            importModuleDynamically:
              vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
          },
        );
        imported.agents.modelRuntime.registerProvider("worklens-test", {
          api: "openai-completions",
          baseUrl: url,
          apiKey: "fixture",
          models: [{ ...model, input: ["text", "image"] }],
        });
        await imported.agents.modelRuntime.refresh({ allowNetwork: false });
      },
      {
        url: server.url,
        model: fixtureModel,
      },
    );
    await page.evaluate(() =>
      window.worklens.invoke("settings", {
        riskAccepted: true,
        defaults: {
          provider: "worklens-test",
          model: "worklens-test",
          thinking: "off",
        },
      }),
    );
    await page.reload();
    expect(
      await page.evaluate(async () => {
        try {
          await navigator.clipboard.readText();
          return "allowed";
        } catch (error) {
          return (error as Error).name;
        }
      }),
    ).toBe("NotAllowedError");
    expect(
      await page.evaluate(
        async () =>
          (await navigator.permissions.query({ name: "notifications" })).state,
      ),
    ).toBe("denied");
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.dataset.clipboardTest = "true";
      frame.allow = "clipboard-write";
      frame.srcdoc = "<button>Test clipboard boundary</button>";
      document.body.append(frame);
    });
    const embedded = page.frameLocator("iframe[data-clipboard-test]");
    await embedded.getByRole("button").click();
    expect(
      await embedded.locator("body").evaluate(async () => {
        try {
          await navigator.clipboard.writeText("synthetic embedded write");
          return "allowed";
        } catch (error) {
          return (error as Error).name;
        }
      }),
    ).toBe("NotAllowedError");
    await page.evaluate(() =>
      document.querySelector("iframe[data-clipboard-test]")?.remove(),
    );
    expect(
      await app.evaluate(async ({ BrowserWindow }) => {
        const main = BrowserWindow.getAllWindows()[0];
        const other = new BrowserWindow({
          show: false,
          webPreferences: { session: main.webContents.session },
        });
        try {
          await other.loadURL(main.webContents.getURL());
          return await other.webContents.executeJavaScript(
            'navigator.permissions.query({name:"clipboard-write"}).then(p => p.state)',
          );
        } finally {
          other.destroy();
        }
      }),
    ).toBe("denied");
    const images = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 400;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#8455ee";
      context.fillRect(0, 0, 640, 400);
      context.fillStyle = "white";
      context.fillText("WorkLens", 30, 50);
      return ["image/png", "image/jpeg", "image/webp"].map((mimeType) => ({
        mimeType,
        source: canvas.toDataURL(mimeType),
      }));
    });
    const phonePhoto = await sharp({
      create: { width: 5712, height: 4284, channels: 3, background: "#8466aa" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    images.push({
      mimeType: "image/jpeg",
      source: `data:image/jpeg;base64,${phonePhoto.toString("base64")}`,
    });
    const chooser = page.waitForEvent("filechooser");
    await page.locator(".aui-composer-add-attachment").click();
    await (
      await chooser
    ).setFiles(
      images.map((image, i) => ({
        name: `image-${i}.${image.mimeType.split("/")[1]}`,
        mimeType: image.mimeType,
        buffer: Buffer.from(image.source.split(",")[1], "base64"),
      })),
    );
    await expect(page.locator(".aui-composer-attachments img")).toHaveCount(4);
    await expect(page.locator(".aui-attachment-tile-uploading")).toHaveCount(0);
    await expect(page.locator(".aui-composer-send")).toBeEnabled();
    await page.locator(".aui-composer-send").click();
    await expect.poll(() => server.requests.length).toBe(1);
    const user = server.requests[0].messages.find(
      (message: any) => message.role === "user",
    );
    const received = user.content
      .filter((part: any) => part.type === "image_url")
      .map((part: any) => part.image_url.url);
    expect(received.slice(0, 3)).toEqual(
      images.slice(0, 3).map((image) => image.source),
    );
    expect(
      imageDimensions(Buffer.from(received[3].split(",")[1], "base64")),
    ).toEqual({ width: 1500, height: 2000 });
    await expect(page.locator(".aui-composer-cancel")).toHaveCount(0);
    await page.reload();
    const previews = page.locator(".aui-user-message-attachments-end img");
    await expect(previews).toHaveCount(4);
    for (let index = 0; index < 3; index++)
      await expect(previews.nth(index)).toHaveJSProperty("naturalWidth", 256);
    await expect(previews.nth(3)).toHaveJSProperty("naturalHeight", 256);
    const tiles = page.locator(
      '.aui-user-message-attachments-end .aui-attachment-root [role="button"]',
    );
    await expect(
      page
        .locator(".aui-user-action-bar-root")
        .getByRole("button", { name: "Copy text", exact: true }),
    ).toHaveCount(0);
    for (let index = 0; index < 3; index++) {
      await app.evaluate(({ clipboard }) =>
        clipboard.writeText("synthetic clipboard marker"),
      );
      await tiles.nth(index).click({ button: "right" });
      await page
        .getByRole("menuitem", { name: "Copy image", exact: true })
        .click();
      await expect
        .poll(() =>
          app.evaluate(async ({ clipboard, nativeImage }) => {
            const item = (await clipboard.read()).find((item) =>
              item.types.includes("image/png"),
            );
            if (!item) return null;
            const blob = (await item.getType("image/png")) as Blob;
            return nativeImage
              .createFromBuffer(Buffer.from(await blob.arrayBuffer()))
              .getSize();
          }),
        )
        .toEqual({ width: 640, height: 400 });
      await page.keyboard.press("Escape");
    }
    await tiles.first().click();
    const previewDialog = page.getByRole("dialog", {
      name: "Image preview",
      exact: true,
    });
    await app.evaluate(({ clipboard }) =>
      clipboard.writeText("synthetic preview marker"),
    );
    await expect(previewDialog).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(previewDialog.getByRole("status")).toHaveText(
      `2 / ${images.length}`,
    );
    await previewDialog.locator("img").click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Copy image", exact: true })
      .click();
    await expect
      .poll(() =>
        app.evaluate(async ({ clipboard, nativeImage }) => {
          const item = (await clipboard.read()).find((item) =>
            item.types.includes("image/png"),
          );
          if (!item) return null;
          const blob = (await item.getType("image/png")) as Blob;
          return nativeImage
            .createFromBuffer(Buffer.from(await blob.arrayBuffer()))
            .getSize();
        }),
      )
      .toEqual({ width: 640, height: 400 });
    const downloadPath = join(root, "downloaded-image.jpeg");
    await app.evaluate(({ BrowserWindow }, path) => {
      (globalThis as any).imageDownload = undefined;
      BrowserWindow.getAllWindows()[0].webContents.session.once(
        "will-download",
        (_event, item) => {
          item.setSavePath(path);
          item.once("done", (_event, state) => {
            (globalThis as any).imageDownload = {
              state,
              filename: item.getFilename(),
              mime: item.getMimeType(),
            };
          });
        },
      );
    }, downloadPath);
    await page
      .getByRole("menuitem", { name: "Download image", exact: true })
      .click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as any).imageDownload))
      .toEqual({
        state: "completed",
        filename: "image-1.jpeg",
        mime: "image/jpeg",
      });
    const saved = await readFile(downloadPath);
    expect(saved.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(
      await app.evaluate(
        ({ nativeImage }, bytes) =>
          nativeImage.createFromBuffer(Buffer.from(bytes)).getSize(),
        [...saved],
      ),
    ).toEqual({ width: 640, height: 400 });
    await expect(page.locator('[data-slot="toast"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    // Restore focus and seed this paste independently of the download interaction.
    await app.evaluate(
      async (
        { BrowserWindow, clipboard, nativeImage, ClipboardItem },
        bytes,
      ) => {
        BrowserWindow.getAllWindows()[0].focus();
        const png = nativeImage.createFromBuffer(Buffer.from(bytes)).toPNG();
        await clipboard.write([
          new ClipboardItem({
            "image/png": new Blob([new Uint8Array(png)], { type: "image/png" }),
          }),
        ]);
      },
      [...saved],
    );
    await page.bringToFront();
    await page.locator(".aui-composer-input").focus();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+V" : "Control+V",
    );
    await expect(page.locator(".aui-composer-attachments img")).toHaveCount(1);
    await page.locator(".aui-attachment-tile-remove").click();
    const bootstrap = await page.evaluate(() =>
      window.worklens.invoke("bootstrap", undefined),
    );
    const id = bootstrap.conversations[0].id;
    const view = await page.evaluate(
      (id) => window.worklens.invoke("open", { id }),
      id,
    );
    expect(JSON.stringify(view)).not.toContain(images[0].source.split(",")[1]);
    const ref = view.messages.find((message) => message.role === "user")!
      .images![0];
    const invalid = await page.evaluate(
      async ({ id, ref }) => {
        try {
          await window.worklens.invoke("chatImage", {
            conversationId: id,
            messageId: ref.messageId,
            index: 0,
          });
          return "accepted";
        } catch (error) {
          return String(error);
        }
      },
      { id, ref },
    );
    expect(invalid).toContain("CHAT_IMAGE_MISSING");
    // Exercise the actual IPC/session path for an image edit and version selection.
    await page.locator(".aui-composer-input").fill("Unsent follow-up");
    await page.locator('[data-slot="aui_user-message-root"]').first().hover();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.locator(".aui-edit-composer-root");
    await expect(editor.locator("img")).toHaveCount(images.length);
    await editor
      .locator(".aui-edit-composer-input")
      .fill("Revised image description");
    await editor.locator(".aui-attachment-tile-remove").nth(1).click();
    await editor.getByRole("button", { name: "Save and regenerate" }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.locator(".aui-composer-cancel")).toHaveCount(0);
    await expect(page.locator(".aui-branch-picker-state")).toHaveText("2 / 2");
    await expect(page.locator(".aui-composer-input")).toHaveValue(
      "Unsent follow-up",
    );
    await expect(previews).toHaveCount(images.length - 1);
    await expect.poll(() => server.requests.length).toBe(2);
    const revisedUser = server.requests[1].messages.filter(
      (message: any) => message.role === "user",
    );
    expect(revisedUser).toHaveLength(1);
    expect(
      revisedUser[0].content
        .filter((part: any) => part.type === "image_url")
        .map((part: any) => part.image_url.url),
    ).toEqual([received[0], received[2], received[3]]);
    await page
      .getByRole("button", { name: "Previous version", exact: true })
      .click();
    await expect(previews).toHaveCount(images.length);
    await page.reload();
    await expect(page.locator(".aui-branch-picker-state")).toHaveText("1 / 2");
    await expect(previews).toHaveCount(images.length);
    await page
      .getByRole("button", { name: "Next version", exact: true })
      .click();
    await expect(previews).toHaveCount(images.length - 1);
    await expect(
      page.getByText("Revised image description", { exact: true }),
    ).toBeVisible();
    await page.evaluate((id) => window.worklens.invoke("delete", { id }), id);
    expect(
      (
        await page.evaluate(() =>
          window.worklens.invoke("bootstrap", undefined),
        )
      ).conversations,
    ).toHaveLength(0);
  } finally {
    await app.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
