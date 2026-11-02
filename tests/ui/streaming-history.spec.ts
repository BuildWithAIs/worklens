import { expect, test, type Page } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

async function setup(page: Page) {
  await mockWorklens(page);
  await page.addInitScript(() => {
    type Fiber = {
      flags: number;
      stateNode: unknown;
      child: Fiber | null;
      sibling: Fiber | null;
      alternate: Fiber | null;
    };
    const probe = {
      version: "",
      measuring: false,
      renders: 0,
      historicalRenders: 0,
      historyRoots: new Set<Element>(),
    };
    (window as any).streamHistoryProbe = probe;
    (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject(renderer: { version: string }) {
        probe.version = renderer.version;
        this.renderers.set(1, renderer);
        return 1;
      },
      onCommitFiberUnmount() {},
      onCommitFiberRoot(_id: number, root: { current: Fiber }) {
        if (!probe.measuring) return;
        const visit = (fiber: Fiber, historical = false) => {
          historical ||= probe.historyRoots.has(fiber.stateNode as Element);
          // React 19.2 PerformedWork, excluding reused children with old flags.
          if (fiber.flags & 1) {
            probe.renders++;
            if (historical) probe.historicalRenders++;
          }
          if (fiber.alternate && fiber.child === fiber.alternate.child) return;
          for (let child = fiber.child; child; child = child.sibling)
            visit(child, historical);
        };
        visit(root.current);
      },
    };
    const invoke = window.worklens.invoke;
    const view: any = {
      id: "stream-history",
      title: "Synthetic streaming history",
      phase: "generating",
      updatedAt: "2026-10-10T00:00:00Z",
      runId: "sample-run",
      revision: 0,
      selection: { provider: "deepseek", model: "flash", thinking: "medium" },
      messages: [
        ...Array.from({ length: 12 }, (_, index) => [
          {
            id: `question-${index}`,
            entryId: `question-${index}`,
            role: "user",
            text: `Synthetic question ${index}`,
          },
          {
            id: `answer-${index}`,
            role: "assistant",
            text: `## Sample ${index}\n\nA synthetic explanation.\n\n| Item | Value |\n| --- | --- |\n| Example | Ready |${index === 0 ? "\n\nThe output is result-note." : ""}`,
          },
        ]).flat(),
        { id: "prompt", entryId: "prompt", role: "user", text: "Continue" },
        { id: "reply", role: "assistant", text: "Live update 0." },
      ],
    };
    let listener: Parameters<typeof window.worklens.onChat>[0] | undefined;
    window.worklens.onChat = (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    };
    (window as any).streamHistoryUpdate = (change?: string) => {
      if (change === "output")
        view.messages.push(
          {
            id: "output",
            role: "tool",
            toolId: "output-call",
            toolName: "write",
            args: JSON.stringify({ path: "workspace/result-note" }),
            targetPath: "workspace/result-note",
            status: "success",
            text: "Saved",
          },
          { id: "followup", role: "assistant", text: "" },
        );
      if (change === "remove")
        view.messages = view.messages.filter(
          (message: any) => message.id !== "output",
        );
      if (change === "complete") view.phase = "completed";
      const previous = view.revision++;
      view.messages.at(-1).text = `Live update ${view.revision}.`;
      const full = previous === 0 || !!change;
      listener?.({
        conversationId: view.id,
        runId: view.runId,
        sequence: view.revision,
        type:
          change === "complete"
            ? "run_end"
            : previous === 0
              ? "run_start"
              : "message_update",
        view: structuredClone({
          ...view,
          messages: full ? view.messages : view.messages.slice(-1),
        }),
        ...(!full && {
          messagesFrom: view.messages.length - 1,
          baseSequence: previous,
        }),
      });
      return view.revision;
    };
    window.worklens.invoke = (async (name: string, input: any) => {
      if (name === "open" || name === "view") return structuredClone(view);
      if (name === "conversationFile")
        return {
          path: input.path,
          kind: "file",
          produced: view.messages.some(
            (message: any) => message.id === "output",
          ),
        };
      const result = await (invoke as any)(name, input);
      if (name === "bootstrap") {
        result.conversations = [
          structuredClone(view),
          ...Array.from({ length: 60 }, (_, index) => ({
            id: `history-${index}`,
            title: `Synthetic history ${index}`,
            phase: "completed",
            updatedAt: "2026-10-01T00:00:00Z",
          })),
        ];
        result.settings.lastConversation = view.id;
      }
      return result;
    }) as typeof window.worklens.invoke;
  });
  await page.goto("/");
  await expect(
    page.locator('[data-slot="progressive-history"]'),
  ).toHaveAttribute("aria-busy", "false");
  await update(page);
}

async function update(page: Page, change?: string) {
  const revision = await page.evaluate(
    (change) => (window as any).streamHistoryUpdate(change),
    change,
  );
  await expect(
    page.getByText(`Live update ${revision}.`, { exact: true }),
  ).toBeVisible();
  return revision;
}

async function measureHistory(page: Page) {
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const probe = (window as any).streamHistoryProbe;
    probe.historyRoots = new Set(
      Array.from(document.querySelectorAll(".messages [data-role]")).slice(
        0,
        24,
      ),
    );
    probe.renders = probe.historicalRenders = 0;
    probe.measuring = true;
  });
  for (let tick = 0; tick < 6; tick++) await update(page);
  const measured = await page.evaluate(() => {
    const probe = (window as any).streamHistoryProbe;
    probe.measuring = false;
    return {
      version: probe.version,
      historyCount: probe.historyRoots.size,
      renders: probe.renders,
      historicalRenders: probe.historicalRenders,
    };
  });
  expect(measured.version).toMatch(/^19\.2\./);
  expect(measured.historyCount).toBe(24);
  expect(measured.renders).toBeGreaterThan(0);
  expect(measured.historicalRenders).toBe(0);
}

test("active streaming preserves historical renders and sidebar scrolling", async ({
  page,
}) => {
  await setup(page);
  const sidebar = page.locator(".conversation-list");
  await sidebar.evaluate((node) => {
    node.scrollTop = 500;
  });
  await measureHistory(page);
  expect(await sidebar.evaluate((node) => node.scrollTop)).toBe(500);
  await sidebar.hover();
  await page.mouse.wheel(0, 250);
  await expect
    .poll(() => sidebar.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(500);
  await expect(
    page.getByRole("button", { name: "Stop task", exact: true }),
  ).toBeVisible();
  const revision = await update(page, "complete");
  await expect(page.locator(".history-loading-ring")).toHaveCount(0);
  await expect(
    page.locator('[data-slot="aui_assistant-message-root"]').last(),
  ).toContainText(`Live update ${revision}.`);
  const firstUser = page.locator('[data-slot="aui_user-message-root"]').first();
  const edit = firstUser.getByRole("button", { name: "Edit", exact: true });
  await edit.focus();
  await edit.press("Enter");
  await expect(page.locator(".aui-edit-composer-input")).toHaveValue(
    "Synthetic question 0",
  );
});

test("file evidence still updates historical links without rerendering them on tokens", async ({
  page,
}) => {
  await setup(page);
  const history = page
    .locator('[data-slot="aui_assistant-message-root"]')
    .first();
  const link = history.locator('[data-slot="local-file-link"]');
  await expect(link).toHaveCount(0);
  await update(page, "output");
  await expect(link).toHaveText("result-note");
  await measureHistory(page);
  await update(page, "remove");
  await expect(link).toHaveCount(0);
  await expect(history).toContainText("The output is result-note.");
});
