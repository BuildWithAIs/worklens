import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

for (const theme of ["light", "dark"]) {
  test(`HTML artifact preview isolation and navigation: ${theme}`, async ({ page }, info) => {
    await mockWorklens(page);
    await page.addInitScript(() => {
      const invoke = window.worklens.invoke;
      const html = '<!doctype html><html lang="en"><head><title>Travel plan</title><style>body{background:#eef4fa;padding:24px}h1{color:#345}</style></head><body><h1>Weekend plan</h1><script>const label = "EXECUTED"; document.body.textContent=label;</script><img src="https://example.invalid/probe"><a href="https://example.invalid/navigate">External</a></body></html>';
      const view = { id: "artifact", title: "Artifact demo", phase: "completed", updatedAt: new Date().toISOString(), messages: [
        { id: "u", role: "user", text: "Make a page" },
        { id: "a", role: "assistant", text: 'Here is your page.\n\n```html\n' + html + '\n```\n\n```html\n<div>Example snippet</div>\n```' },
      ] };
      window.worklens.invoke = async (name, input) => {
        if (name === "open") return view;
        const result = await invoke(name, input);
        if (name === "bootstrap") { result.conversations = [view]; result.settings.lastConversation = view.id; }
        return result;
      };
    });
    const requests = [];
    page.on("request", request => { if (request.url().includes("example.invalid")) requests.push(request.url()); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const card = page.locator('[data-slot="html-artifact-card"]');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Code · HTML");
    expect((await card.boundingBox()).width).toBeLessThanOrEqual(520);
    const resting = await card.evaluate(node => ({ border: getComputedStyle(node).borderColor, shadow: getComputedStyle(node).boxShadow }));
    await card.getByRole("button", { name: /Open preview/ }).hover();
    await expect(card).not.toHaveCSS("border-color", resting.border);
    await expect(card).not.toHaveCSS("box-shadow", resting.shadow);
    await expect(card.getByRole("button", { name: /Open preview/ })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const cardDownload = page.waitForEvent("download");
    await card.getByRole("button", { name: "Download", exact: true }).click();
    expect((await cardDownload).suggestedFilename()).toBe("web-preview.html");
    await expect(page.locator(".artifact-panel")).toHaveCount(0);
    await expect(page.getByText("<div>Example snippet</div>", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: /Open preview/ }).click();
    const panel = page.locator(".artifact-panel");
    await expect(panel).toBeVisible();
    await expect(page.locator("iframe")).toHaveAttribute("sandbox", "");
    const frame = page.frameLocator("iframe");
    await expect(frame.getByRole("heading", { name: "Weekend plan" })).toBeVisible();
    await expect(frame.locator("script")).toHaveCount(0);
    await expect(frame.getByText("External")).not.toHaveAttribute("href");
    expect(requests).toEqual([]);
    await expect(page.locator(".artifact-chat")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`artifact-${theme}.png`) });
    await page.locator("iframe").evaluate(node => window.previewFrameNode = node);
    const toolbar = panel.locator(".artifact-toolbar");
    expect((await toolbar.boundingBox()).height).toBeLessThanOrEqual(50);
    await panel.getByRole("button", { name: "Code", exact: true }).click();
    await expect(page.locator("iframe")).toBeHidden();
    expect(await page.locator("iframe").evaluate(node => node === window.previewFrameNode)).toBe(true);
    await expect(page.locator(".artifact-source")).toHaveCSS("line-height", "20px");
    await panel.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.locator("iframe")).toBeVisible();
    expect(await page.locator("iframe").evaluate(node => node === window.previewFrameNode)).toBe(true);
    await panel.getByRole("button", { name: "Code", exact: true }).click();
    const toggle = panel.locator(".artifact-view-switch");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    expect(await toggle.evaluate(node => getComputedStyle(node, "::before").transitionDuration)).toBe("0.18s");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await toggle.evaluate(node => getComputedStyle(node, "::before").transitionDuration)).toBe("0s");
    await expect(page.locator(".artifact-source")).toContainText("<script>");
    await expect(page.locator(".artifact-source .hljs-name").first()).toBeVisible();
    await expect(page.locator(".artifact-source .language-css")).toBeVisible();
    await expect(page.locator(".artifact-source .language-javascript .hljs-keyword").first()).toBeVisible();
    const nameColor = await page.locator(".artifact-source .hljs-name").first().evaluate(node => getComputedStyle(node).color);
    const attrColor = await page.locator(".artifact-source .hljs-attr").first().evaluate(node => getComputedStyle(node).color);
    expect(attrColor).not.toBe(nameColor);
    await expect(page.locator(".artifact-source pre")).toHaveCSS("white-space", "pre");
    await expect(page.locator(".artifact-source code")).toHaveCSS("white-space", "pre");
    await page.screenshot({ path: info.outputPath(`artifact-code-${theme}.png`) });
    const download = page.waitForEvent("download");
    await panel.getByRole("button", { name: "Artifact actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Open in Google Chrome" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Show in Finder" })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Download as HTML" }).click();
    expect((await download).suggestedFilename()).toBe("web-preview.html");
    await page.setViewportSize({ width: 850, height: 900 });
    await expect(page.locator(".artifact-chat")).toBeHidden();
    await panel.getByRole("button", { name: "Close preview" }).press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(card.getByRole("button", { name: /Open preview/ })).toBeFocused();
    await card.getByRole("button", { name: /Open preview/ }).click();
    await panel.getByRole("button", { name: "Close preview" }).click();
    await expect(card).toBeVisible();
    await page.reload();
    await expect(card).toHaveCount(1);
  });
}

for (const width of [1440, 850]) {
test(`HTML card auto preview respects viewport and close: ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    const view = { id: "stream-html", title: "Streaming HTML", phase: "generating", updatedAt: new Date().toISOString(), messages: [
      { id: "u", role: "user", text: "Make a page" },
      { id: "a", role: "assistant", text: '```html\n<html><head><title>Ready</title></head><body>Completed page</body></html>\n```' },
    ] };
    window.worklens.onChat = listener => { window.finishHtml = () => { view.phase = "completed"; listener({ conversationId: view.id, runId: "html", sequence: 1, type: "run_end", view: structuredClone(view) }); }; return () => {}; };
    window.worklens.invoke = async (name, input) => {
      if (name === "open") return structuredClone(view);
      const result = await invoke(name, input);
      if (name === "bootstrap") { result.conversations = [view]; result.settings.lastConversation = view.id; }
      return result;
    };
  });
  await page.goto("/");
  await expect(page.locator(".aui-md-pre")).toBeVisible();
  await expect(page.locator(".aui-code-header-language")).toHaveText("html");
  await expect(page.locator('[data-slot="html-artifact-card"]')).toHaveCount(0);
  await page.evaluate(() => window.finishHtml());
  await expect(page.locator('[data-slot="html-artifact-card"]')).toHaveCount(1);
  if (width > 1100) {
    await expect(page.locator(".artifact-panel")).toBeVisible();
    await page.getByRole("button", { name: "Close preview" }).click();
  } else {
    await expect(page.locator(".artifact-panel")).toHaveCount(0);
    await expect(page.locator(".artifact-chat")).toBeVisible();
  }
  await page.evaluate(() => window.finishHtml());
  await expect(page.locator(".artifact-panel")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".artifact-panel")).toHaveCount(0);
});
}

test("local HTML links preview and keep native actions independent of preview errors", async ({
  page,
}) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    const view = {
      id: "files",
      title: "Files",
      phase: "completed",
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: "a",
          role: "assistant",
          text: "Done: `/runtime/preview-test.html`\n\n`/runtime/missing.html`",
        },
      ],
    };
    window.worklens.invoke = async (name, input) => {
      if (name === "conversationFile") {
        window.lastFileAction = input;
        const file = { path: input.path, kind: "html" };
        if (input.path.endsWith("missing.html"))
          return { ...file, issue: "missing" };
        return input.action === "preview"
          ? {
              ...file,
              content: "<html><body><h1>Local file</h1></body></html>",
            }
          : file;
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
  const cards = page.locator('[data-slot="html-file-card"]');
  const links = cards.locator(".artifact-card-open");
  await expect(links).toHaveCount(2);
  await expect(cards).toHaveCount(2);
  await cards.first().getByRole("button", { name: "Artifact actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Copy path" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Open in Google Chrome" }).click();
  expect(await page.evaluate(() => window.lastFileAction)).toEqual({
    id: "files",
    path: "/runtime/preview-test.html",
    action: "chrome",
  });
  await cards.first().getByRole("button", { name: "Artifact actions" }).click();
  await page.getByRole("menuitem", { name: "Show in Finder" }).click();
  expect(await page.evaluate(() => window.lastFileAction)).toEqual({
    id: "files",
    path: "/runtime/preview-test.html",
    action: "reveal",
  });
  await links.first().click();
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Local file" }),
  ).toBeVisible();
  await expect(page.locator(".artifact-file-path")).toHaveCount(0);
  await page.locator(".artifact-panel").getByRole("button", { name: "Artifact actions" }).click();
  await expect(page.getByRole("menuitem")).toHaveCount(1);
  await expect(page.getByRole("menuitem", { name: "Download as HTML" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close preview" }).click();
  await expect(links.first()).toBeFocused();
  await links.last().click();
  await expect(page.locator('[data-slot="toast-title"]')).toContainText(
    "File not found",
  );
  await links.first().click();
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Local file" }),
  ).toBeVisible();
});

for (const width of [1440, 850]) {
  test(`generated HTML file restores card and automatic preview: ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockWorklens(page);
    await page.addInitScript(() => {
      const invoke = window.worklens.invoke;
      const view = { id: "generated-html", title: "Generated page", phase: "generating", updatedAt: new Date().toISOString(), messages: [{ id: "a", role: "assistant", text: "Creating your page…" }] };
      window.worklens.onChat = (listener) => {
        window.finishFile = () => {
          view.phase = "completed";
          view.messages[0].text = "[Travel plan](workspace/travel.html)";
          listener({ conversationId: view.id, runId: "html", sequence: 1, type: "run_end", view: structuredClone(view) });
        };
        return () => {};
      };
      window.worklens.invoke = async (name, input) => {
        if (name === "conversationFile") return { path: "/Users/example/WorkLens/sessions/current/workspace/travel.html", kind: "html", ...(input.action === "preview" ? { content: "<html><body><h1>Travel plan</h1></body></html>" } : {}) };
        if (name === "open") return structuredClone(view);
        const result = await invoke(name, input);
        if (name === "bootstrap") { result.conversations = [view]; result.settings.lastConversation = view.id; }
        return result;
      };
    });
    await page.goto("/");
    await expect(page.getByText("Creating your page…", { exact: true })).toBeVisible();
    await page.evaluate(() => window.finishFile());
    const card = page.locator('[data-slot="html-file-card"]');
    await expect(card).toContainText("Travel plan");
    await expect(card).toContainText("Code · HTML");
    if (width > 1100) await expect(page.locator(".artifact-panel")).toBeVisible();
    else {
      await expect(page.locator(".artifact-panel")).toHaveCount(0);
      await card.locator(".artifact-card-open").click();
    }
    await expect(page.frameLocator("iframe").getByRole("heading", { name: "Travel plan" })).toBeVisible();
    await page.getByRole("button", { name: "Close preview" }).click();
    await expect(card).toBeVisible();
  });
}

for (const theme of ["light", "dark"]) {
  test(`saved artifact split actions preserve behavior (${theme})`, async ({ page }, info) => {
    await mockWorklens(page);
    await page.addInitScript(() => {
      localStorage.setItem("worklens.language", "en");
      const invoke = window.worklens.invoke;
      const view = {
        id: "saved-artifact", title: "Saved artifact", phase: "completed",
        updatedAt: new Date().toISOString(),
        messages: [
          { id: "u", role: "user", text: "Create a presentation" },
          { id: "tool", role: "tool", toolId: "save", toolName: "write", status: "success", text: "Saved", args: "{}", artifacts: [
            { id: "ppt", name: "sample-presentation.pptx", path: "/Users/example/Documents/sample-presentation.pptx", size: 4096 },
          ] },
          { id: "a", role: "assistant", text: "```html\n<!doctype html><html><head><title>Preview</title></head><body>Preview</body></html>\n```" },
        ],
      };
      window.artifactCalls = [];
      window.worklens.invoke = async (name, input) => {
        if (name === "artifact") {
          window.artifactCalls.push(input);
          if (window.failArtifact) throw new Error("File unavailable");
          if (window.holdArtifact) await new Promise(resolve => { window.releaseArtifact = resolve; });
          return;
        }
        if (name === "open") return view;
        const result = await invoke(name, input);
        if (name === "bootstrap") { result.conversations = [view]; result.settings.lastConversation = view.id; }
        return result;
      };
    });
    await page.goto("/");
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const card = page.locator('[data-slot="artifact-file-card"]');
    await expect(card).toBeVisible();
    expect((await card.boundingBox()).width).toBe(440);
    const open = card.getByRole("button", { name: "Open", exact: true });
    const menu = card.locator('[data-slot="dropdown-menu-trigger"]');
    await expect(card.getByRole("button")).toHaveCount(2);
    const baseline = page.locator('[data-slot="html-artifact-card"] .artifact-split-button');
    const dimensions = node => [...node.querySelectorAll("button")].map(button => {
      const s = getComputedStyle(button);
      return { height: s.height, radius: s.borderRadius, font: s.fontSize, line: s.lineHeight };
    });
    expect(await card.locator(".artifact-split-button").evaluate(dimensions)).toEqual(await baseline.evaluate(dimensions));
    await card.locator("p").first().hover();
    await expect(page.locator('[data-slot="tooltip-content"]')).toContainText("/Users/example/Documents/");
    await page.mouse.move(0, 0);
    await open.click();
    await expect.poll(() => page.evaluate(() => window.artifactCalls)).toEqual([{ id: "ppt", action: "open" }]);
    await menu.focus();
    await menu.press("Enter");
    await expect(page.getByRole("menuitem")).toHaveCount(2);
    await page.getByRole("menuitem", { name: /Show in (Finder|folder)/ }).click();
    await expect(menu).toBeFocused();
    await menu.click();
    await page.getByRole("menuitem", { name: "Save as", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.artifactCalls.map(call => call.action))).toEqual(["open", "show", "saveAs"]);
    await page.evaluate(() => { window.holdArtifact = true; });
    await open.click();
    await expect(open).toBeDisabled();
    await expect(menu).toBeDisabled();
    await page.evaluate(() => { window.holdArtifact = false; window.releaseArtifact(); });
    await expect(open).toBeEnabled();
    await expect(menu).toBeEnabled();
    await page.evaluate(() => { window.failArtifact = true; });
    await open.click();
    await expect(page.getByRole("alert")).toContainText("File unavailable");
    await page.evaluate(() => { window.failArtifact = false; });
    await open.click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`saved-artifact-${theme}.png`) });
    await page.setViewportSize({ width: 680, height: 850 });
    const bounds = await card.boundingBox();
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(680);
    await expect(menu).toBeInViewport();
    await menu.click();
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
  });
}
