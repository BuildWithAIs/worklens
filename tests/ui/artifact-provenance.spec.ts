import { test, expect } from "@playwright/test";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mockWorklens } from "./fixture.js";
import { projectMessages } from "../../src/main/projection";
import { LocalArtifacts } from "../../src/main/local-artifacts";

for (const language of ["en", "zh"]) {
  for (const missing of ["unregistered", "removed"]) {
    test(`${missing} PDF metadata has no local actions; same-named remote and saved references retain their identities (${language})`, async ({
      page,
    }) => {
      const root = await mkdtemp(join(tmpdir(), "artifact-provenance-"));
      try {
        const storage = new LocalArtifacts(
          join(root, "artifacts"),
          join(root, "sessions"),
        );
        const local = await storage.save(
          "synthetic-session",
          "reference-paper.pdf",
          "%PDF-1.4\nSynthetic reference",
        );
        const absent =
          missing === "removed"
            ? await storage.save(
                "synthetic-session",
                "reference-paper.pdf",
                "%PDF-1.4\nRemoved reference",
              )
            : {
                ...local,
                id: randomUUID(),
                path: join(root, "never-saved", "reference-paper.pdf"),
              };
        if (missing === "removed") await unlink(absent.path);
        const remote =
          "https://docs.example.test/download/attachments/9/reference-paper.pdf";
        const messages = projectMessages([
          {
            role: "user",
            content: [{ type: "text", text: "Find a reference" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "lookup",
                name: "confluence_read",
                arguments: {
                  request: { operation: "search", cql: "type=attachment" },
                },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "lookup",
            toolName: "confluence_read",
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  items: [
                    {
                      id: "42",
                      type: "attachment",
                      title: "reference-paper.pdf",
                      url: remote,
                    },
                  ],
                }),
              },
            ],
            // The renderer must verify metadata independently of its origin.
            details: {
              artifacts: [
                absent,
                { ...local, id: "remote-reference", path: remote },
                local,
              ],
            },
          },
          {
            role: "assistant",
            content: [{ type: "text", text: `[Source](${remote})` }],
          },
        ]);
        const actions: { id: string; action: string }[] = [];
        const external: string[] = [];
        await page.exposeFunction(
          "syntheticArtifact",
          async (input: { id: string; action: string }) => {
            actions.push(input);
            const file = await storage.get(input.id);
            return input.action === "inspect" ? { file } : undefined;
          },
        );
        await page.exposeFunction("syntheticExternal", (url: string) =>
          external.push(url),
        );
        await mockWorklens(page);
        await page.addInitScript(
          ({ messages, language }) => {
            localStorage.setItem("worklens.language", language);
            const browser = window as any;
            const original = browser.worklens.invoke;
            const view = {
              id: "artifact-provenance",
              title: "Reference lookup",
              phase: "completed",
              updatedAt: new Date().toISOString(),
              messages,
            };
            browser.worklens.invoke = async (method: string, input: any) => {
              if (method === "artifact")
                return browser.syntheticArtifact(input);
              if (method === "external")
                return browser.syntheticExternal(input.url);
              if (method === "open") return view;
              const result = await original(method, input);
              if (method === "bootstrap") {
                result.conversations = [view];
                result.settings.lastConversation = view.id;
              }
              return result;
            };
          },
          { messages, language },
        );
        await page.goto("/");
        const status = page.locator('[data-slot="artifact-file-status"]');
        await expect(status).toHaveCount(1);
        await expect(status).toContainText(
          language === "en" ? "Local file unavailable" : "本地文件不可用",
        );
        await expect(status.getByRole("button")).toHaveCount(0);
        const card = page.locator('[data-slot="artifact-file-card"]');
        await expect(card).toHaveCount(1);
        const link = page.locator('[data-slot="artifact-remote-reference"] a');
        await expect(link).toHaveAttribute("href", remote);
        const typography = (node: HTMLElement) => ({
          size: getComputedStyle(node).fontSize,
          line: getComputedStyle(node).lineHeight,
          color: getComputedStyle(node).color,
        });
        expect(await link.evaluate(typography)).toEqual(
          await page
            .getByRole("link", { name: "Source", exact: true })
            .evaluate(typography),
        );
        await link.click();
        await link.focus();
        await page.keyboard.press("Enter");
        expect(external).toEqual([remote, remote]);
        expect(actions.every((action) => action.action === "inspect")).toBe(
          true,
        );
        expect(actions.some((action) => action.id === "remote-reference")).toBe(
          false,
        );

        // A previously valid file can disappear before the user clicks it.
        await unlink(local.path);
        await card
          .getByRole("button", {
            name: language === "en" ? "Open" : "打开",
            exact: true,
          })
          .click();
        await expect(card).toHaveCount(0);
        await expect(status).toHaveCount(2);
        expect(actions.filter((action) => action.action !== "inspect")).toEqual(
          [{ id: local.id, action: "open" }],
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test("pending and obsolete artifact inspections cannot enable actions for another reference", async ({
  page,
}) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const browser = window as any;
    localStorage.setItem("worklens.language", "en");
    const original = browser.worklens.invoke;
    const oldFile = {
      id: "old-file",
      name: "old-reference.pdf",
      path: "/tmp/synthetic-old-reference.pdf",
      size: 1024,
    };
    const newFile = {
      id: "new-file",
      name: "new-reference.pdf",
      path: "/tmp/synthetic-new-reference.pdf",
      size: 2048,
    };
    const view = {
      id: "changing-artifact",
      title: "Changing reference",
      phase: "completed",
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: "tool",
          toolId: "tool",
          role: "tool",
          toolName: "confluence_read",
          status: "success",
          text: "Reference",
          artifacts: [oldFile],
        },
        { id: "reply", role: "assistant", text: "Reference ready." },
      ],
    };
    browser.worklens.onChat = (listener: (event: unknown) => void) => {
      browser.changeArtifact = () => {
        view.messages[0].artifacts = [newFile];
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
    browser.worklens.invoke = async (method: string, input: any) => {
      if (method === "artifact" && input.action === "inspect") {
        if (input.id === oldFile.id)
          return new Promise((resolve) => {
            browser.finishOldArtifact = () => resolve({ file: oldFile });
          });
        return { file: newFile };
      }
      if (method === "open") return structuredClone(view);
      const result = await original(method, input);
      if (method === "bootstrap") {
        result.conversations = [view];
        result.settings.lastConversation = view.id;
      }
      return result;
    };
  });
  await page.goto("/");
  await expect(
    page.locator('[data-slot="artifact-file-status"]'),
  ).toContainText("Checking file…");
  await expect(page.locator('[data-slot="artifact-file-card"]')).toHaveCount(0);
  await page.evaluate(() => (window as any).changeArtifact());
  const card = page.locator('[data-slot="artifact-file-card"]');
  await expect(card).toContainText("new-reference.pdf");
  await page.evaluate(() => (window as any).finishOldArtifact());
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("new-reference.pdf");
  await expect(card).not.toContainText("old-reference.pdf");
});
