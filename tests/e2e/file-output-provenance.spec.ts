import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

test("legacy runtime HTML output retains a preview card through real file IPC", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-output-provenance-"));
  const runtime = join(root, "runtime");
  const sessions = join(root, "sessions");
  await mkdir(runtime, { recursive: true });
  await mkdir(sessions, { recursive: true });
  const output = join(runtime, "index.html");
  const reference = join(runtime, "existing.html");
  const html =
    "<!doctype html><html><body><h1>Generated legacy page</h1></body></html>";
  await writeFile(output, html);
  await writeFile(reference, "<html>Existing source page</html>");
  const reportDir = join(runtime, "bili_luming");
  await mkdir(reportDir);
  const report = join(reportDir, "REPORT.md");
  await writeFile(report, "Report");
  await writeFile(
    join(reportDir, "report.html"),
    "<html><body><h1>Sibling report preview</h1></body></html>",
  );
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const assistant = (content: unknown[], stopReason = "stop") => ({
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const messages = [
    { role: "user", content: "写个简单的html", timestamp: Date.now() },
    assistant(
      [
        {
          type: "toolCall",
          id: "write-page",
          name: "write",
          arguments: { path: output, content: html },
        },
      ],
      "toolUse",
    ),
    {
      role: "toolResult",
      toolCallId: "write-page",
      toolName: "write",
      content: [{ type: "text", text: "Successfully wrote index.html" }],
      isError: false,
      timestamp: Date.now(),
    },
    assistant(
      [
        {
          type: "toolCall",
          id: "edit-report",
          name: "edit",
          arguments: { path: report, oldText: "Old", newText: "Report" },
        },
      ],
      "toolUse",
    ),
    {
      role: "toolResult",
      toolCallId: "edit-report",
      toolName: "edit",
      content: [{ type: "text", text: "Updated" }],
      isError: false,
      timestamp: Date.now(),
    },
    assistant([
      {
        type: "text",
        text: `报告文件（REPORT.md / report.html）里现在还有受这个错误影响的表述。\n\n已创建 \`${output}\`。\n\n内容很简单：一个页面。\n\n打开方式：\n\n\`\`\`bash\nopen ${output}\n\`\`\`\n\n现有参考 \`${reference}\`。`,
      },
    ]),
  ];
  const records = [
    { type: "session", version: 3, id, timestamp, cwd: runtime },
    ...messages.map((message, i) => ({
      type: "message",
      id: `entry-${i}`,
      parentId: i ? `entry-${i - 1}` : null,
      timestamp,
      message,
    })),
    {
      type: "session_info",
      id: "title",
      parentId: `entry-${messages.length - 1}`,
      timestamp,
      name: "Legacy HTML output",
    },
  ];
  await writeFile(
    join(sessions, `${id}.jsonl`),
    records.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env))
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/.test(key))
      delete env[key];
  const app = await electron.launch({
    args: ["."],
    cwd: resolve("."),
    env: env as Record<string, string>,
  });
  try {
    const page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Legacy HTML output", exact: true })
      .click();
    const card = page.locator('[data-slot="html-file-card"]');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("index.html");
    await expect(
      page.getByRole("link", { name: "existing.html", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        ({ id, path }) =>
          window.worklens.invoke("conversationFile", {
            id,
            path,
            action: "inspect",
          }),
        { id, path: output },
      ),
    ).toMatchObject({ kind: "html", produced: true });
    const reportLink = page.getByRole("link", {
      name: "REPORT.md",
      exact: true,
    });
    const htmlLink = page.getByRole("link", {
      name: "report.html",
      exact: true,
    });
    await expect(reportLink).toBeVisible();
    await expect(htmlLink).toBeVisible();
    const paragraph = page
      .locator(".aui-md-p")
      .filter({ hasText: "报告文件（" });
    await expect(paragraph).toHaveText(
      "报告文件（REPORT.md / report.html）里现在还有受这个错误影响的表述。",
    );
    await expect(paragraph.locator("button")).toHaveCount(0);
    await expect(paragraph.locator('[data-slot="html-file-card"]')).toHaveCount(
      0,
    );
    const spacing = await paragraph.evaluate((node) => {
      const links = node.querySelectorAll("a");
      const canvas = document.createElement("canvas").getContext("2d")!;
      canvas.font = getComputedStyle(node).font;
      return {
        actual:
          links[1].getBoundingClientRect().left -
          links[0].getBoundingClientRect().right,
        expected: canvas.measureText(" / ").width,
      };
    });
    expect(Math.abs(spacing.actual - spacing.expected)).toBeLessThan(1);
    const bounds = await htmlLink.boundingBox();
    await reportLink.hover();
    await reportLink.focus();
    expect(await htmlLink.boundingBox()).toEqual(bounds);
    await page.screenshot({
      path: test.info().outputPath("report-inline-links.png"),
    });
    await htmlLink.click();
    await expect(
      page
        .frameLocator("iframe")
        .getByRole("heading", { name: "Sibling report preview" }),
    ).toBeVisible();
    await card.locator(".artifact-card-open").click();
    await expect(
      page
        .frameLocator("iframe")
        .getByRole("heading", { name: "Generated legacy page" }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("legacy-html-preview.png"),
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const legacy of [true, false]) {
  test(`shell deliverables have links and SVG preview without extension gating (legacy: ${legacy})`, async () => {
    const { worklensTools } = await import("../../src/main/tools");
    const root = await mkdtemp(join(tmpdir(), "worklens-shell-delivery-"));
    const runtime = join(root, "runtime");
    const sessions = join(root, "sessions");
    await mkdir(runtime, { recursive: true });
    await mkdir(sessions, { recursive: true });
    await writeFile(join(runtime, "existing.sh"), "echo existing");
    const tool = worklensTools(runtime, () => {}).find(
      (tool) =>
        tool.name === (process.platform === "win32" ? "powershell" : "bash"),
    )!;
    // Exercise the real wrapper and persisted details, not fabricated produced flags.
    const script =
      "const f=require('node:fs'); f.mkdirSync('logo'); for(const name of ['bmw-logo-white.svg','result.uninventedformat123456789','README','.env','报告 最终版']) f.writeFileSync('logo/'+name, name.endsWith('.svg') ? '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"80\" height=\"80\"><rect width=\"80\" height=\"80\" fill=\"royalblue\"/></svg>' : 'delivered'); f.writeFileSync('logo/preview-white.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=','base64'));";
    const scriptPath = join(runtime, "make-output.cjs");
    await writeFile(scriptPath, script);
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    const command =
      process.platform === "win32"
        ? `& '${process.execPath.replace(/'/g, "''")}' '${scriptPath.replace(/'/g, "''")}'`
        : `${quote(process.execPath)} ${quote(scriptPath)}`;
    const result = await tool.execute(
      "make",
      { command },
      undefined,
      undefined,
    );
    const names = [
      "bmw-logo-white.svg",
      "preview-white.png",
      "result.uninventedformat123456789",
      "README",
      ".env",
      "报告 最终版",
    ];
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const text =
      "## 已保存文件\n\n" +
      names
        .map((name) =>
          legacy
            ? `- [${name}](<${join(runtime, "logo", name)}>) — 已保存`
            : `- ${name} — 已保存`,
        )
        .join("\n") +
      "\n\n你的 `existing.sh` 保持原样。\n\n[普通引用](existing.sh)\n\n[官网](https://example.com/)";
    const usage = {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const messages = [
      { role: "user", content: "保存文件", timestamp: Date.now() },
      {
        role: "assistant",
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
        stopReason: "toolUse",
        timestamp: Date.now(),
        usage,
        content: [
          {
            type: "toolCall",
            id: "make",
            name: tool.name,
            arguments: { command },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "make",
        toolName: tool.name,
        content: result.content,
        details: legacy ? { worklensShell: { exitCode: 0 } } : result.details,
        isError: false,
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
        stopReason: "stop",
        timestamp: Date.now(),
        usage,
        content: [{ type: "text", text }],
      },
    ];
    const records = [
      { type: "session", version: 3, id, timestamp, cwd: runtime },
      ...messages.map((message, index) => ({
        type: "message",
        id: `m${index}`,
        parentId: index ? `m${index - 1}` : null,
        timestamp,
        message,
      })),
      {
        type: "session_info",
        id: "name",
        parentId: "m3",
        timestamp,
        name: "Shell outputs",
      },
    ];
    await writeFile(
      join(sessions, `${id}.jsonl`),
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: root };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const key of Object.keys(env))
      if (
        /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/.test(key)
      )
        delete env[key];
    const app = await electron.launch({
      args: ["."],
      cwd: resolve("."),
      env: env as Record<string, string>,
    });
    try {
      const page = await app.firstWindow();
      await page
        .getByRole("button", { name: "Shell outputs", exact: true })
        .click();
      for (const name of names)
        await expect(
          page.getByRole("link", { name, exact: true }),
        ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "existing.sh", exact: true }),
      ).toBeVisible();
      const reference = page.getByRole("link", {
        name: "普通引用",
        exact: true,
      });
      await expect(reference).toBeVisible();
      await expect(
        reference.locator("..").locator("..").locator(".local-file-menu"),
      ).toHaveCount(0);
      await expect(page.locator(".local-file-menu")).toHaveCount(0);
      await page
        .getByRole("link", { name: "bmw-logo-white.svg", exact: true })
        .click();
      await expect(
        page.locator('[data-slot="image-zoom-overlay"]'),
      ).toBeVisible();
      const image = page.locator('img[data-slot="image-zoom-content"]');
      await expect(image).toHaveAttribute("src", /^data:image\/svg\+xml/);
      await expect
        .poll(() =>
          image.evaluate((node: HTMLImageElement) => node.naturalWidth),
        )
        .toBe(80);
      await page.screenshot({
        path: test.info().outputPath(`shell-svg-${legacy}.png`),
      });
      await page.keyboard.press("Escape");
      await app.evaluate(({ shell }) => {
        (globalThis as any).openedOutputPaths = [];
        shell.openPath = async (path) => {
          (globalThis as any).openedOutputPaths.push(path);
          return "";
        };
      });
      await page
        .getByRole("link", {
          name: "result.uninventedformat123456789",
          exact: true,
        })
        .click();
      await page.getByRole("link", { name: "README", exact: true }).click();
      await expect
        .poll(async () => {
          const opened = await app.evaluate(
            () => (globalThis as any).openedOutputPaths,
          );
          return opened.map((path: string) => path.split("/").pop());
        })
        .toEqual(["result.uninventedformat123456789", "README"]);
      await page.reload();
      for (const name of names)
        await expect(
          page.getByRole("link", { name, exact: true }),
        ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "官网", exact: true }),
      ).toHaveCSS("text-decoration-line", "underline");
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
