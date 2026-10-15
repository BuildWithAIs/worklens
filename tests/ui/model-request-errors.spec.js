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
    title: "Couldn’t authenticate with the provider",
    detail: "Invalid API key",
    actions: ["Open settings"],
  },
  {
    name: "explicit provider billing error",
    error: "402 Insufficient credits",
    title: "The provider reported a quota or billing limit",
    detail: "Insufficient credits",
    actions: ["Choose model"],
  },
  {
    name: "network error without billing speculation",
    error: "Connection timed out",
    title: "The request timed out",
    detail:
      "Try again. If it keeps timing out, check your network or proxy settings.",
    actions: [],
  },
  {
    name: "unknown failure uses a generic message",
    title: "The model request failed",
    detail: "Try again.",
    actions: [],
  },
  {
    name: "failure before an assistant message exists",
    error: "Service unavailable",
    noAssistant: true,
    title: "The model service is temporarily unavailable",
    detail: "Try again later, or choose another model.",
    actions: ["Choose model"],
  },
  {
    name: "message-level error fallback",
    messageError: "Provider rejected the request",
    title: "The model request failed",
    detail: "Provider rejected the request",
    actions: [],
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
    await expect(error.locator(".aui-message-error-title")).toHaveText(
      scenario.title ?? "The model request failed",
    );
    await expect(error.locator(".aui-message-error-message")).toHaveText(
      scenario.detail ?? scenario.error,
    );
    if (!scenario.error?.includes("credits")) {
      await expect(error).not.toContainText(/credits|balance|充值|余额/i);
    }
    // The fixture prompt has no stored entry, so Retry cannot resend it.
    if (scenario.actions)
      await expect(
        error.getByRole("button").filter({ hasNotText: "Details" }),
      ).toHaveText(scenario.actions);
    if (scenario.text)
      await expect(
        page.getByText(scenario.text, { exact: true }),
      ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop task", exact: true }),
    ).toHaveCount(0);
  });
}

test("provider errors show the provider's explanation and keep the original in Details", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await setup(page);
  const raw =
    '503: {"message":"Service is too busy. Try another provider. (request_id: 40ee2127-9214-448d-a299-5c0b7e1d93fa)"}';
  await page.evaluate((error) => window.finishRequest({ error }), raw);
  const error = page.locator(".aui-message-error-root");
  await expect(error).toHaveAttribute("data-kind", "unavailable");
  await expect(error.locator(".aui-message-error-title")).toHaveText(
    "The model service is temporarily unavailable",
  );
  await expect(error.locator(".aui-message-error-message")).toHaveText(
    "Service is too busy. Try another provider.",
  );
  await expect(error.locator("pre")).toHaveCount(0);
  const details = error.getByRole("button", { name: "Details", exact: true });
  await details.click();
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(error.locator("pre")).toHaveText(raw);
  await error.getByRole("button", { name: "Copy details" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(raw);
});

test("error actions retry the last prompt and choose a model", async ({
  page,
}) => {
  await setup(page, {
    branchId: "branch",
    messages: [{ id: "user", entryId: "user", role: "user", text: "Hello" }],
  });
  await page.evaluate(() => {
    const invoke = window.worklens.invoke;
    window.worklens.invoke = async (name, input) => {
      if (name === "editMessage") {
        window.editInput = input;
        throw new Error("fixture stop");
      }
      return invoke(name, input);
    };
    window.finishRequest({ error: "503 Service unavailable" });
  });
  const error = page.locator(".aui-message-error-root");
  await error.getByRole("button", { name: "Retry" }).click();
  await expect
    .poll(() => page.evaluate(() => window.editInput))
    .toMatchObject({ messageId: "user", text: "Hello", images: [] });

  await error.getByRole("button", { name: "Choose model" }).click();
  await expect(page.locator(".chat-model-picker")).toBeVisible();
});

test("authentication errors open provider settings", async ({ page }) => {
  await setup(page);
  await page.evaluate(() =>
    window.finishRequest({ error: "401 Invalid API key" }),
  );
  await page
    .locator(".aui-message-error-root")
    .getByRole("button", { name: "Open settings" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Providers", exact: true }),
  ).toBeVisible();
});

test("earlier failures stay readable without next steps", async ({ page }) => {
  await setup(page, {
    phase: "completed",
    branchId: "branch",
    messages: [
      { id: "user", entryId: "user", role: "user", text: "Hello" },
      {
        id: "failure",
        role: "assistant",
        text: "",
        error: "503 Service unavailable",
        status: "error",
      },
      { id: "followup", entryId: "followup", role: "user", text: "Again" },
      { id: "answer", role: "assistant", text: "Successful reply" },
    ],
  });
  const error = page.locator(".aui-message-error-root");
  await expect(error.locator(".aui-message-error-title")).toContainText(
    "The model service is temporarily unavailable",
  );
  await expect(error.getByRole("button")).toHaveText(["Details"]);
});

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
    /line-clamp-3/,
  );
  await response
    .getByRole("button", { name: "Copy text", exact: true })
    .click();
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
  await response
    .getByRole("button", { name: "Copy text", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Partial answer",
  );
  const user = page.locator('[data-slot="aui_user-message-root"]');
  await user.hover();
  await user.getByRole("button", { name: "Copy text", exact: true }).click();
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
    const detail = page.locator(
      ".aui-message-error-root .aui-message-error-message",
    );
    await expect(detail).toHaveText("Provider rejected the request");
    await page.reload();
    await expect(detail).toHaveText("Provider rejected the request");
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
