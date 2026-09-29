import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mockServer, fixtureModel } from "../mock-server";
import sharp from "sharp";
import { imageDimensions } from "../../src/shared/image-dimensions";

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
    const images = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 100;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#8455ee";
      context.fillRect(0, 0, 160, 100);
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
      await expect(previews.nth(index)).toHaveJSProperty("naturalWidth", 160);
    await expect(previews.nth(3)).toHaveJSProperty("naturalHeight", 256);
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
