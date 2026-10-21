import { test, expect, type Page } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

async function setup(page: Page) {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const probe = {
      rendererVersion: "",
      commits: [] as number[],
      renderSamples: [] as number[],
      settledMs: [] as number[],
      streaming: false,
      stopStreaming: false,
      typedDuringStream: 0,
    };
    (window as any).backgroundProbe = probe;
    type Fiber = {
      flags: number;
      child: Fiber | null;
      sibling: Fiber | null;
      alternate: Fiber | null;
    };
    // React 19.2's PerformedWork flag is set for rendered components in both
    // development and production builds. No component names or timing needed.
    (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject(renderer: { version: string }) {
        probe.rendererVersion = renderer.version;
        this.renderers.set(1, renderer);
        return 1;
      },
      onCommitFiberUnmount() {},
      onCommitFiberRoot(_id: number, root: { current: Fiber }) {
        let rendered = 0;
        const visit = (fiber: Fiber) => {
          if (fiber.flags & 1) rendered++;
          // A bailed-out subtree reuses its child fibers, including old flags.
          // Counting those flags again would count work from an earlier commit.
          if (fiber.alternate && fiber.child === fiber.alternate.child) return;
          for (let child = fiber.child; child; child = child.sibling)
            visit(child);
        };
        visit(root.current);
        probe.commits.push(rendered);
      },
    };
    const invoke = window.worklens.invoke;
    const views: Record<string, any> = {};
    for (let index = 0; index < 150; index++) {
      const id = `sample-${index}`;
      views[id] = {
        id,
        title: `Sample conversation ${index}`,
        phase: index === 1 ? "generating" : "completed",
        updatedAt: "2026-10-10T00:00:00Z",
        selection: { provider: "deepseek", model: "flash", thinking: "medium" },
        messages: Array.from({ length: index < 2 ? 20 : 0 }, (_, turn) => [
          {
            id: `${id}-user-${turn}`,
            role: "user",
            text: `Sample question ${turn}`,
          },
          {
            id: `${id}-answer-${turn}`,
            role: "assistant",
            text: `Sample answer ${turn}.\n\n| Item | Value |\n| --- | --- |\n| A | 10 |`,
          },
        ]).flat(),
      };
    }
    let listener: Parameters<typeof window.worklens.onChat>[0] | undefined;
    let sequence = 0;
    window.worklens.onChat = (callback) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    };
    (window as any).backgroundUpdate = (completed = false) => {
      const view = views["sample-1"];
      view.messages.at(-1).text += `\nBackground update ${++sequence}`;
      view.phase = completed ? "completed" : "generating";
      view.runId = "sample-background-run";
      view.revision = sequence;
      listener?.({
        conversationId: view.id,
        runId: view.runId,
        sequence,
        type: completed
          ? "run_end"
          : sequence === 1
            ? "run_start"
            : "message_update",
        view: structuredClone({
          ...view,
          messages:
            sequence === 1 || completed
              ? view.messages
              : view.messages.slice(-1),
        }),
        ...(sequence > 1 && !completed
          ? {
              messagesFrom: view.messages.length - 1,
              baseSequence: sequence - 1,
            }
          : {}),
      });
      return sequence;
    };
    document.addEventListener("input", (event) => {
      if (
        (event.target as Element).matches(".aui-composer-input") &&
        probe.streaming
      )
        probe.typedDuringStream++;
    });
    window.worklens.invoke = (async (name: string, input: any) => {
      if (name === "open") return structuredClone(views[input.id]);
      if (["model", "send", "cancel"].includes(name)) {
        (window as any).calls.push({ name, input });
        const id = input.id ?? input.conversationId ?? "new-sample";
        const view = (views[id] ??= {
          id,
          title: "New sample",
          messages: [],
          updatedAt: "2026-10-11T00:00:00Z",
          phase: "completed",
        });
        if (name === "model") view.selection = input.selection;
        if (name === "send") {
          view.selection = input.selection;
          view.phase = "generating";
          view.runId = `${id}-run`;
          view.messages.push({
            id: `${id}-draft`,
            role: "user",
            text: input.text,
          });
        }
        return structuredClone(view);
      }
      const result = await (invoke as any)(name, input);
      if (name === "bootstrap") {
        result.conversations = Object.values(views);
        result.settings.lastConversation = "sample-0";
      }
      return result;
    }) as typeof window.worklens.invoke;
  });
  await page.goto("/");
  await expect(
    page.locator('[data-slot="progressive-history"]'),
  ).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".aui-composer-input")).toBeFocused();
}

for (const target of ["existing", "new"] as const) {
  test(`background streaming avoids unrelated renders while typing in ${target === "existing" ? "an existing" : "a new"} conversation`, async ({
    page,
  }, info) => {
    await setup(page);
    if (target === "new")
      await page.getByRole("button", { name: "New chat", exact: true }).click();
    const composer = page.locator(".aui-composer-input");
    const backgroundRow = page.locator(".conversation-item").filter({
      has: page.getByRole("button", {
        name: "Sample conversation 1",
        exact: true,
      }),
    });
    const initial = await page.evaluate(() => (window as any).backgroundProbe);
    // Make an unsupported renderer or a disconnected hook fail visibly.
    expect(initial.rendererVersion).toMatch(/^19\.2\./);
    expect(Math.max(...initial.commits)).toBeGreaterThan(1000);
    await page.evaluate(async () => {
      const probe = (window as any).backgroundProbe;
      const frame = () => new Promise(requestAnimationFrame);
      // The first update legitimately moves the running conversation in Recents.
      (window as any).backgroundUpdate();
      await frame();
      await frame();
      // Measure isolated updates so input renders cannot inflate the counts.
      for (let tick = 0; tick < 6; tick++) {
        const before = probe.commits.length;
        const start = performance.now();
        (window as any).backgroundUpdate();
        while (probe.commits.length === before) await frame();
        await frame();
        await frame();
        probe.renderSamples.push(
          probe.commits
            .slice(before)
            .reduce((a: number, b: number) => a + b, 0),
        );
        // Includes two frames for follow-up commits; diagnostic, not latency.
        probe.settledMs.push(performance.now() - start);
      }
    });
    const measured = await page.evaluate(() => (window as any).backgroundProbe);
    await info.attach("background-update-work", {
      body: JSON.stringify({
        target,
        renders: measured.renderSamples,
        settledMs: measured.settledMs,
      }),
      contentType: "application/json",
    });
    expect(measured.renderSamples).toHaveLength(6);
    expect(Math.min(...measured.renderSamples)).toBeGreaterThan(0);
    // Updating another session must not render thousands of sidebar controls
    // and the current chat. The allowance covers App, header and search work.
    expect(Math.max(...measured.renderSamples)).toBeLessThan(500);
    const composerBefore = await composer.boundingBox();
    const rowBefore = await backgroundRow.boundingBox();
    await composer.fill("Input before the streaming loop");
    expect(
      await page.evaluate(
        () => (window as any).backgroundProbe.typedDuringStream,
      ),
    ).toBe(0);
    await composer.fill("");
    const draft =
      "An independent draft stays responsive while another conversation streams a reply.";
    const streaming = page.evaluate(async () => {
      const probe = (window as any).backgroundProbe;
      probe.streaming = true;
      let updates = 0;
      try {
        while (!probe.stopStreaming) {
          (window as any).backgroundUpdate();
          updates++;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      } finally {
        probe.streaming = false;
      }
      return updates;
    });
    await page.waitForFunction(() => (window as any).backgroundProbe.streaming);
    let updates: number;
    try {
      await composer.pressSequentially(draft, { delay: 20 });
    } finally {
      await page.evaluate(() => {
        (window as any).backgroundProbe.stopStreaming = true;
      });
      updates = await streaming;
    }
    expect(updates).toBeGreaterThan(1);
    await expect(composer).toHaveValue(draft);
    await expect(composer).toBeFocused();
    expect(await composer.boundingBox()).toEqual(composerBefore);
    // Running conversations still move through Recents in the existing order.
    const rowAfter = await backgroundRow.boundingBox();
    expect(rowAfter?.height).toBe(rowBefore?.height);
    expect(rowAfter?.width).toBe(rowBefore?.width);
    const probe = await page.evaluate(() => (window as any).backgroundProbe);
    expect(probe.streaming).toBe(false);
    expect(probe.typedDuringStream).toBeGreaterThan(10);
    await composer.pressSequentially("!");
    // The run is still generating here; only the update loop has stopped.
    expect(
      await page.evaluate(
        () => (window as any).backgroundProbe.typedDuringStream,
      ),
    ).toBe(probe.typedDuringStream);
    const completedSequence = await page.evaluate(() =>
      (window as any).backgroundUpdate(true),
    );
    await expect(backgroundRow.locator(".history-loading-ring")).toHaveCount(0);
    await expect(backgroundRow.locator(".conversation-unread")).toHaveCount(1);
    await expect(composer).toHaveValue(`${draft}!`);
    await backgroundRow.locator(".conversation-open").click();
    await expect(
      page.getByText(`Background update ${completedSequence}`, {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="aui_assistant-message-root"]'),
    ).toHaveCount(20);
    await expect(backgroundRow.locator(".conversation-unread")).toHaveCount(0);
  });
}

test("stable composer actions use the current conversation, model and run after navigation", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => (window as any).backgroundUpdate());
  await page
    .getByRole("button", { name: "Sample conversation 2", exact: true })
    .click();
  await expect(page.locator(".aui-composer-input")).toBeFocused();
  await page.getByRole("button", { name: "Choose model", exact: true }).click();
  await page
    .getByRole("button", { name: "DeepSeek V4 Pro", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await page.evaluate(() => (window as any).backgroundUpdate());
  await page
    .locator(".aui-composer-input")
    .fill("Send in the selected conversation");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).calls.findLast((call: any) => call.name === "send")
            ?.input,
      ),
    )
    .toMatchObject({
      conversationId: "sample-2",
      text: "Send in the selected conversation",
      selection: { provider: "deepseek", model: "pro", thinking: "medium" },
    });
  await page.getByRole("button", { name: "Stop task", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).calls.findLast((call: any) => call.name === "cancel")
            ?.input,
      ),
    )
    .toEqual({ conversationId: "sample-2", runId: "sample-2-run" });
});
