import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

async function setup(page, language = "en") {
  await mockWorklens(page);
  await page.addInitScript((language) => {
    localStorage.setItem("worklens.language", language);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.copiedPath = value;
        },
      },
    });
    const invoke = window.worklens.invoke;
    const root =
      "/Users/example/Library/Application Support/WorkLens/sessions/12345678-1234-1234-1234-123456789012/workspace/";
    const view = {
      id: "local-files",
      title: "Local files",
      phase: "completed",
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: "a",
          role: "assistant",
          text: "预览图也已生成：\n\nworkspace/sample-layout-wide.png\n\n`workspace/sample-layout-small.jpg`\n\n[Report](</Users/example/Documents/季度报告 final.pdf>)\n\n`/Users/example/Documents/`\n\n`workspace/large.html`\n\n`workspace/deleted.png`\n\n[Website](https://example.com/image.png)\n\n```text\nworkspace/example.png\n```",
        },
      ],
    };
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 600;
    const drawing = canvas.getContext("2d");
    drawing.fillStyle = "#f0f4f7";
    drawing.fillRect(0, 0, 960, 600);
    drawing.fillStyle = "#17394d";
    drawing.font = "48px sans-serif";
    drawing.fillText("Sample layout preview", 60, 100);
    drawing.fillStyle = "#d7e3eb";
    drawing.fillRect(60, 150, 840, 390);
    drawing.fillStyle = "#17394d";
    drawing.font = "24px sans-serif";
    drawing.fillText("Local image preview fixture", 100, 220);
    const preview = canvas.toDataURL("image/png");
    window.fileActions = [];
    window.worklens.invoke = async (name, input) => {
      if (name === "conversationFile") {
        window.fileActions.push(input);
        const path = input.path.startsWith("workspace/")
          ? root + input.path.slice(10)
          : input.path;
        const kind = path.endsWith("/")
          ? "directory"
          : /\.html$/.test(path)
            ? "html"
            : /\.(png|jpg)$/.test(path)
              ? "image"
              : "file";
        const file = { path, kind, produced: true };
        if (path.includes("deleted")) return { ...file, issue: "missing" };
        if (input.action === "preview" && path.includes("large"))
          return { ...file, issue: "tooLarge" };
        if (input.action === "preview" && kind === "image")
          return { ...file, content: preview };
        return file;
      }
      if (name === "external") {
        window.externalUrl = input.url;
        return;
      }
      if (name === "open") return view;
      const result = await invoke(name, input);
      if (name === "bootstrap") {
        result.conversations = [view];
        result.settings.lastConversation = view.id;
      }
      return result;
    };
  }, language);
  await page.goto("/");
}

test.describe("touch file actions", () => {
  test.use({ hasTouch: true });
  test("long press opens actions without inline controls", async ({ page }) => {
    await setup(page);
    await expect(page.locator(".local-file-menu")).toHaveCount(0);
    const link = page.locator('[data-slot="local-file-link"]').first();
    const box = await link.boundingBox();
    const client = await page.context().newCDPSession(page);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + 5, y: box.y + 5 }],
    });
    await expect(page.getByRole("menu")).toBeVisible();
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  });
});

for (const theme of ["light", "dark"]) {
  test(`file paths stay lightweight and wrap; image preview shares keyboard behavior (${theme})`, async ({
    page,
  }, info) => {
    await setup(page);
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    const links = page.locator('[data-slot="local-file-link"]');
    await expect(links).toHaveCount(4);
    const image = links.filter({ hasText: "sample-layout-wide.png" });
    await expect(image).toHaveText("sample-layout-wide.png");
    await expect(image).toHaveCSS("white-space", "normal");
    await expect(image).toHaveCSS("overflow-wrap", "anywhere");
    await expect(image.locator("..").getByRole("button")).toHaveCount(0);
    await expect(page.locator(".local-file-menu")).toHaveCount(0);
    const restingBounds = await image.boundingBox();
    await image.hover();
    expect(await image.boundingBox()).toEqual(restingBounds);
    await image.focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menuitem").first()).toBeFocused();
    await page
      .getByRole("menu")
      .screenshot({ path: info.outputPath(`file-menu-${theme}.png`) });
    await page.keyboard.press("Escape");
    await expect(image).toBeFocused();
    const web = page.getByRole("link", { name: "Website", exact: true });
    const typography = (node) => ({
      size: getComputedStyle(node).fontSize,
      line: getComputedStyle(node).lineHeight,
      color: getComputedStyle(node).color,
    });
    expect(await image.evaluate(typography)).toEqual(
      await web.evaluate(typography),
    );
    await expect(page.locator('[data-slot="html-file-card"]')).toHaveCount(1);
    await expect(page.locator(".aui-md-pre")).toContainText(
      "workspace/example.png",
    );
    await image.focus();
    await image.press("Enter");
    await expect(
      page.locator('[data-slot="image-zoom-overlay"]'),
    ).toBeVisible();
    await expect(page.locator(".image-preview-path")).toContainText(
      "/Users/example/Library/Application Support/",
    );
    await expect(page.locator(".image-preview-path")).toContainText(
      "sample-layout-wide.png",
    );
    await expect(page.locator(".artifact-panel")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(image).toBeFocused();
    await page.mouse.move(0, 0);
    await image.hover();
    await image.click({ button: "right" });
    await expect(page.getByRole("menuitem")).toHaveCount(2);
    await page.getByRole("menuitem", { name: "Copy path" }).click();
    await expect
      .poll(() => page.evaluate(() => window.copiedPath))
      .toContain("/Users/example/Library/Application Support/");
    await expect(
      page
        .locator('[data-slot="toast-title"]')
        .filter({ hasText: "Path copied" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-slot="image-zoom-overlay"]')).toHaveCount(
      0,
    );
    await image.click();
    await expect(
      page.locator('[data-slot="image-zoom-overlay"]'),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`image-preview-${theme}.png`),
    });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 680, height: 850 });
    expect(
      await image.evaluate(
        (node) => node.getBoundingClientRect().right <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`file-paths-${theme}.png`) });
    await web.click();
    expect(await page.evaluate(() => window.externalUrl)).toBe(
      "https://example.com/image.png",
    );
  });
}

for (const language of ["en", "zh"]) {
  test(`native actions work for files, directories and oversized previews (${language})`, async ({
    page,
  }) => {
    await setup(page, language);
    const links = page.locator('[data-slot="local-file-link"]');
    const report = links.filter({ hasText: /^Report$/ });
    await report.click();
    expect(
      (await page.evaluate(() => window.fileActions)).at(-1),
    ).toMatchObject({
      action: "open",
      path: "/Users/example/Documents/季度报告 final.pdf",
    });
    const directory = links.filter({
      hasText: /^Documents$/,
    });
    await directory.click();
    expect((await page.evaluate(() => window.fileActions)).at(-1).action).toBe(
      "open",
    );
    const large = page.locator('[data-slot="html-file-card"]');
    await large.locator(".artifact-card-open").click();
    await expect(page.locator('[data-slot="toast-title"]')).toContainText(
      language === "en" ? "too large" : "文件过大",
    );
    await large
      .getByRole("button", {
        name: language === "en" ? "Artifact actions" : "作品操作",
      })
      .click();
    await page
      .getByRole("menuitem", {
        name: language === "en" ? "Show in Finder" : "在 Finder 中显示",
        exact: true,
      })
      .click();
    expect((await page.evaluate(() => window.fileActions)).at(-1).action).toBe(
      "reveal",
    );
    await expect(page.getByRole("menu")).toHaveCount(0);
    await large
      .getByRole("button", {
        name: language === "en" ? "Artifact actions" : "作品操作",
      })
      .press("Enter");
    await page
      .getByRole("menuitem", {
        name:
          language === "en"
            ? "Open in Google Chrome"
            : "在 Google Chrome 中打开",
        exact: true,
      })
      .click();
    expect((await page.evaluate(() => window.fileActions)).at(-1).action).toBe(
      "chrome",
    );
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(links.filter({ hasText: "deleted.png" })).toHaveCount(0);
    await expect(
      page.locator("code").filter({ hasText: /^workspace\/deleted\.png$/ }),
    ).toBeVisible();
  });
}

for (const theme of ["light", "dark"]) {
  test(`generated file list separates HTML and shows filenames (${theme})`, async ({
    page,
  }, info) => {
    await mockWorklens(page);
    await page.addInitScript(() => {
      const invoke = window.worklens.invoke;
      const view = {
        id: "deliverables",
        title: "Generated content",
        phase: "completed",
        updatedAt: new Date().toISOString(),
        messages: [
          {
            id: "a",
            role: "assistant",
            text: "### 生成内容\n\n- `sample-captions.srt`：示例字幕数据\n- `workspace/sample-log.txt`：示例运行记录\n- `workspace/sample-summary.md`：示例文档摘要\n- `workspace/sample-page.html`：示例交互页面\n- `workspace/sample-sound.mp3`：示例音频文件\n- `workspace/records.js`：示例数据集合\n- `workspace/controller.js`：示例交互脚本",
          },
        ],
      };
      window.worklens.invoke = async (name, input) => {
        if (name === "conversationFile")
          return {
            path:
              "/Users/example/Library/Application Support/WorkLens/sessions/current/workspace/" +
              input.path.split("/").pop(),
            kind: input.path.endsWith(".html") ? "html" : "file",
            produced: true,
          };
        if (name === "open") return view;
        const result = await invoke(name, input);
        if (name === "bootstrap") {
          result.conversations = [view];
          result.settings.lastConversation = view.id;
        }
        return result;
      };
    });
    await page.goto("/");
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    const links = page.locator('[data-slot="local-file-link"]');
    await expect(links).toHaveText([
      "sample-captions.srt",
      "sample-log.txt",
      "sample-summary.md",
      "sample-page.html",
      "sample-sound.mp3",
      "records.js",
      "controller.js",
    ]);
    for (const link of await links.all()) {
      expect(
        await link.evaluate((node) =>
          node
            .closest('[data-slot="local-file-reference"]')
            .nextSibling?.textContent?.startsWith("："),
        ),
      ).toBe(true);
      await link.hover();
      await expect(link.locator("..").getByRole("button")).toHaveCount(0);
    }
    await page.mouse.move(0, 0);
    const card = page.locator('[data-slot="html-file-card"]');
    await expect(card).toContainText("sample-page.html");
    await expect(card).toContainText("Code · HTML");
    await expect(page.locator('li [data-slot="html-file-card"]')).toHaveCount(
      0,
    );
    const description = page.locator("li").filter({ hasText: "示例交互页面" });
    await expect(description).toBeVisible();
    expect((await description.boundingBox()).y).toBeLessThan(
      (await card.boundingBox()).y,
    );
    await expect(page.locator(".aui-md")).not.toContainText("workspace/");
    await page.screenshot({
      path: info.outputPath(`deliverables-${theme}.png`),
    });
    await page
      .getByRole("link", { name: "sample-captions.srt", exact: true })
      .hover();
    await expect(page.locator('[data-slot="tooltip-content"]')).toContainText(
      "/Users/example/Library/Application Support/",
    );
    await page.mouse.move(0, 0);
    await page.setViewportSize({ width: 680, height: 850 });
    expect(
      await card.evaluate(
        (node) => node.getBoundingClientRect().right <= window.innerWidth,
      ),
    ).toBe(true);
  });
}

test("changing a file target clears pending state and ignores its old response", async ({
  page,
}) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    const view = {
      id: "changing-file",
      title: "Changing file",
      phase: "generating",
      updatedAt: new Date().toISOString(),
      messages: [{ id: "a", role: "assistant", text: "`workspace/old.png`" }],
    };
    window.worklens.onChat = (listener) => {
      window.changeFile = () => {
        view.messages[0].text = "`workspace/new.txt`";
        listener({
          conversationId: view.id,
          runId: "change",
          sequence: 1,
          type: "message",
          view: structuredClone(view),
        });
      };
      return () => {};
    };
    window.fileCalls = [];
    window.worklens.invoke = async (name, input) => {
      if (name === "conversationFile") {
        window.fileCalls.push(input);
        if (input.path === "workspace/old.png" && input.action === "preview")
          return new Promise((resolve) => {
            window.finishOld = () =>
              resolve({
                path: "/tmp/old.png",
                kind: "image",
                issue: "missing",
              });
          });
        return {
          path: "/tmp/" + input.path.split("/").pop(),
          kind: input.path.endsWith("png") ? "image" : "file",
          produced: true,
        };
      }
      if (name === "open") return structuredClone(view);
      const result = await invoke(name, input);
      if (name === "bootstrap") {
        result.conversations = [view];
        result.settings.lastConversation = view.id;
      }
      return result;
    };
  });
  await page.goto("/");
  const link = page.locator('[data-slot="local-file-link"]');
  await link.click();
  await expect(link).toHaveAttribute("aria-busy", "true");
  await page.evaluate(() => window.changeFile());
  await expect(link).toHaveText("new.txt");
  await expect(link).toHaveAttribute("aria-busy", "false");
  await page.evaluate(() => window.finishOld());
  await expect(page.locator('[data-slot="toast-title"]')).toHaveCount(0);
  await link.click();
  await expect
    .poll(() => page.evaluate(() => window.fileCalls.at(-1)))
    .toMatchObject({ path: "workspace/new.txt", action: "open" });
});

for (const theme of ["light", "dark"]) {
  test(`missing suggestions stay text and available prose references become links (${theme})`, async ({
    page,
  }, info) => {
    await mockWorklens(page);
    await page.addInitScript(() => {
      const invoke = window.worklens.invoke;
      const view = {
        id: "file-suggestions",
        title: "Files",
        phase: "generating",
        updatedAt: new Date().toISOString(),
        messages: [
          {
            id: "a",
            role: "assistant",
            text: "我可以帮你写成文件，比如：\n\n- `国学入门计划.md`：12 周读什么\n- `workspace/关系表.html`：关系速查\n- [参考表](参考表.md)：还没输出\n\n你的 `statusline-command.sh` 已经在读取配置。\n\n网页路径 `/gk/xdnt/` 保持原样。",
          },
        ],
      };
      window.fileChecks = [];
      window.worklens.onChat = (listener) => {
        window.finishSuggestedFile = () => {
          window.suggestionExists = true;
          view.phase = "completed";
          listener({
            conversationId: view.id,
            runId: "files",
            sequence: 1,
            type: "run_end",
            view: structuredClone(view),
          });
        };
        return () => {};
      };
      window.worklens.invoke = async (name, input) => {
        if (name === "conversationFile") {
          window.fileChecks.push(input);
          if (input.path === "statusline-command.sh") {
            if (input.action === "inspect" && !window.scriptInspected) {
              return new Promise((resolve) => {
                window.confirmScript = () => {
                  window.scriptInspected = true;
                  resolve({ path: "/tmp/statusline-command.sh", kind: "file" });
                };
              });
            }
            return { path: "/tmp/statusline-command.sh", kind: "file" };
          }
          return {
            path: "/tmp/" + input.path,
            kind: input.path.endsWith("html") ? "html" : "file",
            ...(window.suggestionExists && input.path === "国学入门计划.md"
              ? { produced: true }
              : { issue: "missing" }),
          };
        }
        if (name === "open") return structuredClone(view);
        const result = await invoke(name, input);
        if (name === "bootstrap") {
          result.conversations = [view];
          result.settings.lastConversation = view.id;
        }
        return result;
      };
    });
    await page.goto("/");
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await expect
      .poll(() => page.evaluate(() => typeof window.confirmScript))
      .toBe("function");
    await expect(
      page.locator('[data-slot="local-file-reference"]'),
    ).toHaveCount(0);
    await expect(page.locator('[data-slot="html-file-card"]')).toHaveCount(0);
    await expect(
      page.locator("code").filter({ hasText: /^statusline-command\.sh$/ }),
    ).toBeVisible();
    await page.evaluate(() => window.confirmScript());
    const script = page.getByRole("link", {
      name: "statusline-command.sh",
      exact: true,
    });
    await expect(script).toBeVisible();
    await expect(
      page.locator('[data-slot="local-file-reference"]'),
    ).toHaveCount(1);
    await expect(page.locator('[data-slot="html-file-card"]')).toHaveCount(0);
    await expect(page.locator("li")).toHaveCount(3);
    await expect(
      page.locator("code").filter({ hasText: /^国学入门计划\.md$/ }),
    ).toBeVisible();
    await expect(
      page.locator("code").filter({ hasText: /^workspace\/关系表\.html$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "参考表", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.locator("code").filter({ hasText: /^\/gk\/xdnt\/$/ }),
    ).toBeVisible();
    await script.hover();
    await expect(page.locator(".local-file-menu")).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath(`file-suggestions-${theme}.png`),
    });
    await page.evaluate(() => window.finishSuggestedFile());
    await expect(
      page.getByRole("link", { name: "国学入门计划.md", exact: true }),
    ).toBeVisible();
    await expect(page.locator('[data-slot="html-file-card"]')).toHaveCount(0);
  });
}

for (const theme of ["light", "dark"]) {
  test(`output records distinguish deliverables from existing references (${theme})`, async ({
    page,
  }) => {
    await mockWorklens(page);
    await page.addInitScript(() => {
      const invoke = window.worklens.invoke;
      const view = {
        id: "output-provenance",
        title: "Output provenance",
        phase: "completed",
        updatedAt: new Date().toISOString(),
        messages: [
          {
            id: "a",
            role: "assistant",
            text: "现有配置 `workspace/config.toml`，脚本 `workspace/existing.sh`，图片 `workspace/existing.png`，说明 `workspace/existing.txt`，页面 `workspace/existing.html`。\n\n已生成 `workspace/result.png` 和 `workspace/result.txt`，脚本 `workspace/result.sh`。\n\n[官网](https://example.com/page.html)",
          },
        ],
      };
      window.worklens.invoke = async (name, input) => {
        if (name === "conversationFile")
          return {
            path: "/tmp/" + input.path,
            kind: input.path.endsWith("html")
              ? "html"
              : input.path.endsWith("png")
                ? "image"
                : "file",
            produced: input.path.includes("result."),
          };
        if (name === "external") {
          window.externalUrl = input.url;
          return;
        }
        if (name === "open") return view;
        const result = await invoke(name, input);
        if (name === "bootstrap") {
          result.conversations = [view];
          result.settings.lastConversation = view.id;
        }
        return result;
      };
    });
    await page.goto("/");
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await expect(page.locator('[data-slot="local-file-link"]')).toHaveText([
      "config.toml",
      "existing.sh",
      "existing.png",
      "existing.txt",
      "existing.html",
      "result.png",
      "result.txt",
      "result.sh",
    ]);
    await expect(page.locator('[data-slot="html-file-card"]')).toHaveCount(0);
    for (const name of [
      "config.toml",
      "existing.sh",
      "existing.png",
      "existing.txt",
      "existing.html",
    ]) {
      await expect(
        page.locator("code").filter({ hasText: `workspace/${name}` }),
      ).toHaveCount(0);
      await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
    }
    const web = page.getByRole("link", { name: "官网", exact: true });
    await expect(web).toHaveCSS("text-decoration-line", "underline");
    await web.click();
    await expect
      .poll(() => page.evaluate(() => window.externalUrl))
      .toBe("https://example.com/page.html");
  });
}
