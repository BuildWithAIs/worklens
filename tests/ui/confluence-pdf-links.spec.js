import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

test("remote PDF citations stay web links beside a downloaded PDF with the same name", async ({
  page,
}) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    localStorage.setItem("worklens.language", "en");
    const invoke = window.worklens.invoke;
    const remote =
      "https://wiki.example.test/confluence/download/attachments/11/report.pdf?version=2";
    const local = "/Users/example/Documents/report.pdf";
    const view = {
      id: "pdf-citations",
      title: "PDF citations",
      phase: "completed",
      updatedAt: new Date().toISOString(),
      messages: [
        { id: "user", role: "user", text: "Find a PDF and download a copy" },
        {
          id: "search",
          role: "tool",
          toolId: "search",
          toolName: "confluence_read",
          args: JSON.stringify({
            request: { operation: "search", cql: "type=attachment" },
          }),
          status: "success",
          text: JSON.stringify({
            items: [
              {
                id: "21",
                type: "attachment",
                title: "report.pdf",
                url: remote,
              },
            ],
          }),
          artifacts: [],
        },
        {
          id: "download",
          role: "tool",
          toolId: "download",
          toolName: "confluence_read",
          args: JSON.stringify({
            request: { operation: "download_attachment", attachmentId: "21" },
          }),
          status: "success",
          text: "Downloaded",
          artifacts: [
            { id: "saved-pdf", name: "report.pdf", path: local, size: 4096 },
          ],
        },
        {
          id: "assistant",
          role: "assistant",
          text: `[report.pdf](${remote})\n\nSaved copy: [report.pdf](${local})`,
        },
      ],
    };
    window.pdfActions = [];
    window.worklens.invoke = async (method, input) => {
      if (method === "artifact" && input.action === "inspect")
        return { file: view.messages[2].artifacts[0] };
      if (method === "external" || method === "artifact") {
        window.pdfActions.push({ method, input });
        return;
      }
      if (method === "conversationFile")
        return { path: local, kind: "file", produced: true };
      if (method === "open") return view;
      const result = await invoke(method, input);
      if (method === "bootstrap") {
        result.conversations = [view];
        result.settings.lastConversation = view.id;
      }
      return result;
    };
  });
  await page.goto("/");
  const remote = page.locator('a[href^="https://wiki.example.test/"]');
  await expect(remote).toHaveText("report.pdf");
  await expect(page.locator('[data-slot="artifact-file-card"]')).toHaveCount(1);
  await expect(page.locator('[data-slot="local-file-link"]')).toHaveCount(1);
  await remote.click();
  await remote.focus();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => window.pdfActions)).toEqual(
    Array(2).fill({
      method: "external",
      input: {
        url: "https://wiki.example.test/confluence/download/attachments/11/report.pdf?version=2",
      },
    }),
  );
  const card = page.locator('[data-slot="artifact-file-card"]');
  await card.getByRole("button", { name: "Open", exact: true }).click();
  await card.getByRole("button", { name: "File actions: report.pdf" }).click();
  await page.getByRole("menuitem", { name: /Show in (Finder|folder)/ }).click();
  expect((await page.evaluate(() => window.pdfActions)).slice(-2)).toEqual([
    { method: "artifact", input: { id: "saved-pdf", action: "open" } },
    { method: "artifact", input: { id: "saved-pdf", action: "show" } },
  ]);
});
