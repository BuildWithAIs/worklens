import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

async function setup(page, initial = {}) {
  await mockWorklens(page);
  await page.addInitScript((initial) => {
    const view = {
      id: "request-error",
      title: "Request error",
      phase: "generating",
      updatedAt: new Date().toISOString(),
      selection: { provider: "deepseek", model: "flash", thinking: "off" },
      messages: [{ id: "user", role: "user", text: "Hello" }],
      ...initial,
    };
    let deliver;
    window.worklens.onChat = (listener) => {
      deliver = listener;
      return () => {};
    };
    window.finishRequest = ({
      error,
      messageError,
      text = "",
      thinking,
      noAssistant,
      phase = "failed",
    }) => {
      view.phase = phase;
      view.error = error;
      if (!noAssistant)
        view.messages.push({
          id: "assistant",
          role: "assistant",
          text,
          thinking,
          error: messageError ?? error,
          status:
            phase === "failed"
              ? "error"
              : phase === "cancelled"
                ? "cancelled"
                : undefined,
        });
      deliver({
        conversationId: view.id,
        runId: "run",
        sequence: 1,
        type: "run_end",
        view: structuredClone(view),
      });
    };
    const invoke = window.worklens.invoke;
    window.worklens.invoke = async (name, input) => {
      if (name === "open") return structuredClone(view);
      const result = await invoke(name, input);
      if (name === "bootstrap") {
        result.conversations = [view];
        result.settings.lastConversation = view.id;
      }
      return result;
    };
  }, initial);
  await page.goto("/");
  await expect(page.getByText("Hello", { exact: true })).toBeVisible();
}

const cases = [
  {
    name: "authentication error before any text",
    error: "401 Invalid API key",
  },
  {
    name: "explicit provider billing error",
    error: "402 Insufficient credits",
  },
  {
    name: "network error without billing speculation",
    error: "Connection timed out",
  },
  {
    name: "unknown failure uses a generic message",
    expected: "The model request failed.",
  },
  {
    name: "failure before an assistant message exists",
    error: "Service unavailable",
    noAssistant: true,
  },
  {
    name: "message-level error fallback",
    messageError: "Provider rejected the request",
    expected: "Provider rejected the request",
  },
  {
    name: "partial answer remains visible",
    error: "Response interrupted",
    text: "Partial answer",
  },
  {
    name: "thinking-only failure displays once",
    error: "Response interrupted",
    thinking: "Some reasoning",
  },
  {
    name: "thinking and partial answer share one failure hint",
    error: "Response interrupted",
    thinking: "Some reasoning",
    text: "Partial answer",
  },
];

for (const scenario of cases) {
  test(scenario.name, async ({ page }) => {
    await setup(page);
    await page.evaluate((scenario) => window.finishRequest(scenario), scenario);
    const error = page.locator(".aui-message-error-root");
    await expect(error).toHaveCount(1);
    await expect(error).toBeVisible();
    await expect(error).toHaveText(scenario.expected ?? scenario.error);
    if (!scenario.error?.includes("credits")) {
      await expect(error).not.toContainText(/credits|balance|充值|余额/i);
    }
    if (scenario.text)
      await expect(
        page.getByText(scenario.text, { exact: true }),
      ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop task", exact: true }),
    ).toHaveCount(0);
  });
}

test("cancelling a request does not produce a failure hint", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() =>
    window.finishRequest({
      phase: "cancelled",
      messageError: "Request aborted",
    }),
  );
  await expect(page.locator(".aui-message-error-root")).toHaveCount(0);
});

test("copy on a textless failure includes the complete visually clamped error", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await setup(page);
  const error =
    "Provider rejected the request.\n" +
    "Additional provider details. ".repeat(40) +
    "\nRequest ID: fixture-123";
  await page.evaluate((error) => window.finishRequest({ error }), error);
  const response = page
    .locator('[data-slot="aui_assistant-message-root"]')
    .filter({ has: page.locator(".aui-message-error-root") });
  await expect(response.locator(".aui-message-error-message")).toHaveClass(
    /line-clamp-2/,
  );
  await response.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(
    response.getByRole("button", { name: "Copied", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(error);
});

test("copying a partial reply or user message still copies its original text", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await setup(page);
  await page.evaluate(() =>
    window.finishRequest({
      text: "Partial answer",
      error: "Response interrupted",
    }),
  );
  const response = page.locator('[data-slot="aui_assistant-message-root"]');
  await response.getByRole("button", { name: "Copy", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Partial answer",
  );
  const user = page.locator('[data-slot="aui_user-message-root"]');
  await user.hover();
  await user.getByRole("button", { name: "Copy", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Hello",
  );
});

for (const phase of ["idle", "completed"]) {
  test(`persisted errors remain visible with conversation phase ${phase}`, async ({
    page,
  }) => {
    const messages = [
      { id: "user", role: "user", text: "Hello" },
      {
        id: "failure",
        role: "assistant",
        text: "",
        error: "Provider rejected the request",
        status: "error",
      },
    ];
    if (phase === "completed")
      messages.push(
        { id: "followup", role: "user", text: "Try again" },
        { id: "answer", role: "assistant", text: "Successful reply" },
      );
    await setup(page, { phase, messages });
    await expect(page.locator(".aui-message-error-root")).toHaveText(
      "Provider rejected the request",
    );
    await page.reload();
    await expect(page.locator(".aui-message-error-root")).toHaveText(
      "Provider rejected the request",
    );
    if (phase === "completed")
      await expect(
        page.getByText("Successful reply", { exact: true }),
      ).toBeVisible();
  });
}

test("persisted cancellation and active retries are not shown as failures", async ({
  page,
}) => {
  await setup(page, {
    phase: "retrying",
    messages: [
      { id: "user", role: "user", text: "Hello" },
      {
        id: "cancelled",
        role: "assistant",
        text: "",
        status: "cancelled",
        error: "Request aborted",
      },
      { id: "followup", role: "user", text: "Try again" },
      {
        id: "retry",
        role: "assistant",
        text: "",
        status: "error",
        error: "Temporary service failure",
      },
    ],
  });
  await expect(page.locator(".aui-message-error-root")).toHaveCount(0);
  await expect(page.locator('[data-slot="activity-progress"]')).toContainText(
    "Retrying",
  );
});
