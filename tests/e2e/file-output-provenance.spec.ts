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
    assistant([
      {
        type: "text",
        text: `已创建 \`${output}\`。\n\n内容很简单：一个页面。\n\n打开方式：\n\n\`\`\`bash\nopen ${output}\n\`\`\`\n\n现有参考 \`${reference}\`。`,
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
      parentId: "entry-3",
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
      page.locator("code").filter({ hasText: reference }),
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
