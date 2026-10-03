import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";
import type { MessageView, ConversationView } from "../../src/shared/contracts";

declare global {
  interface Window {
    updateToolWait: (
      messages: MessageView[],
      phase?: ConversationView["phase"],
    ) => void;
  }
}

for (const language of ["en", "zh"])
  for (const theme of ["light", "dark"])
    test(`shared waiting row: ${language}, ${theme}`, async ({
      page,
    }, testInfo) => {
      await mockWorklens(page);
      await page.addInitScript(
        ({ language, theme }) => {
          localStorage.setItem("worklens.language", language);
          localStorage.setItem("worklens.theme", theme);
          const invoke = window.worklens.invoke;
          let deliver: (event: unknown) => void;
          let sequence = 0;
          const view: ConversationView = {
            id: "tool-wait",
            title: "Waiting fixture",
            phase: "tool",
            updatedAt: new Date().toISOString(),
            selection: {
              provider: "deepseek",
              model: "flash",
              thinking: "medium",
            },
            messages: [
              { id: "user", role: "user", text: "Search Confluence" },
              {
                id: "first",
                toolId: "first",
                role: "tool",
                toolName: "confluence_read",
                text: "",
                status: "running",
              },
            ],
          };
          window.worklens.onChat = (listener) => {
            deliver = listener as typeof deliver;
            return () => {};
          };
          window.updateToolWait = (messages, phase = "tool") => {
            view.messages = [view.messages[0], ...messages];
            view.phase = phase;
            deliver({
              conversationId: view.id,
              sequence: ++sequence,
              type: "tool_resource_status",
              view: structuredClone(view),
            });
          };
          window.worklens.invoke = (async (method, input) => {
            if (method === "open") return structuredClone(view);
            const result = await invoke(method, input);
            if (method === "bootstrap") {
              const bootstrap = result as Awaited<
                ReturnType<typeof invoke<"bootstrap">>
              >;
              bootstrap.conversations = [view];
              bootstrap.settings.lastConversation = view.id;
            }
            return result;
          }) as typeof window.worklens.invoke;
        },
        { language, theme },
      );
      await page.setViewportSize({ width: 480, height: 860 });
      await page.goto("/");
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      const row = page.locator('[data-slot="activity-progress"]');
      await expect(row).toHaveCount(1);
      const height = (await row.boundingBox())!.height;
      const waiting: MessageView = {
        id: "first",
        toolId: "first",
        role: "tool",
        toolName: "confluence_read",
        text: "",
        status: "waiting",
        waitReason: "queue",
      };
      await page.evaluate(
        (message) => window.updateToolWait([message]),
        waiting,
      );
      await expect(row).toHaveText(
        language === "en"
          ? "confluence_read · Waiting…"
          : "confluence_read · 等待中…",
      );
      expect((await row.boundingBox())!.height).toBe(height);
      const trigger = row.locator('[data-slot="tooltip-trigger"]');
      await trigger.focus();
      await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
        language === "en"
          ? "Waiting for other requests to finish."
          : "正在等待其他请求完成。",
      );
      await page.keyboard.press("Escape");
      const suffix = row.locator(".shrink-0.whitespace-pre");
      const geometry = await suffix.evaluate((node) => ({
        width: node.clientWidth,
        full: node.scrollWidth,
      }));
      expect(geometry.width).toBe(geometry.full);
      await page.screenshot({ path: testInfo.outputPath("waiting.png") });

      // A waiting child cannot hide an active sibling; the Code Mode parent
      // itself does not count as active network work once all children wait.
      const parent: MessageView = {
        ...waiting,
        id: "parent",
        toolId: "parent",
        toolName: "codemode",
        status: "running",
      };
      const active: MessageView = {
        ...waiting,
        id: "active",
        toolId: "active",
        parentToolCallId: "parent",
        toolName: "jira_read",
        status: "running",
      };
      const queued = { ...waiting, parentToolCallId: "parent" };
      await page.evaluate(
        (messages) => window.updateToolWait(messages),
        [parent, active, queued],
      );
      await expect(row).toContainText("jira_read");
      await expect(row).not.toContainText(
        language === "en" ? "Waiting" : "等待中",
      );
      await page.evaluate(
        (messages) => window.updateToolWait(messages),
        [parent, { ...active, status: "success" as const }, queued],
      );
      await expect(row).toContainText(
        language === "en" ? "Waiting…" : "等待中…",
      );

      for (const [name, reason] of [
        ["write", "resource"],
        ["future_connector", "retry"],
        ["tavily_research_status", "remote"],
      ] as const) {
        await page.evaluate((message) => window.updateToolWait([message]), {
          ...waiting,
          toolName: name,
          waitReason: reason,
        });
        await expect(row).toHaveText(
          `${name} · ${language === "en" ? "Waiting…" : "等待中…"}`,
        );
      }
      await page.evaluate((message) => window.updateToolWait([message]), {
        ...waiting,
        status: "running" as const,
        waitReason: undefined,
      });
      await expect(row).not.toContainText(
        language === "en" ? "Waiting" : "等待中",
      );
      await expect(row.locator('[data-slot="tooltip-trigger"]')).toHaveCount(0);
      expect((await row.boundingBox())!.height).toBe(height);
      await page.evaluate(
        (message) => window.updateToolWait([message], "completed"),
        { ...waiting, status: "cancelled" as const, waitReason: undefined },
      );
      await expect(
        page.getByText(
          language === "en"
            ? "confluence_read · Waiting…"
            : "confluence_read · 等待中…",
          { exact: true },
        ),
      ).toHaveCount(0);
    });
