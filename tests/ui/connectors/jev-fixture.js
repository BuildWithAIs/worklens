import { mockWorklens } from "../fixture.js";

export async function mockJev(
  page,
  {
    language = "en",
    theme = "light",
    connected = true,
    conversation = false,
  } = {},
) {
  await mockWorklens(page);
  await page.addInitScript(
    ({ language, theme, connected, conversation }) => {
      localStorage.setItem("worklens.language", language);
      const invoke = window.worklens.invoke;
      let jev = connected
        ? { url: "https://api.typesafe.ai", configured: true }
        : undefined;
      const selection = {
        provider: "deepseek",
        model: "flash",
        thinking: "medium",
      };
      const views = Object.fromEntries(
        ["sample-chat", "other-chat"].map((id, i) => [
          id,
          {
            id,
            title: i ? "Other conversation" : "Sample feedback",
            phase: "completed",
            selection,
            updatedAt: "2026-09-24T01:00:00Z",
            revision: 0,
            messages: [
              {
                id: "user",
                role: "user",
                text: "Classify the sample feedback.",
              },
              {
                id: "assistant",
                role: "assistant",
                text: "I will review the selected feedback.",
              },
            ],
            jevConsent: {
              blocked: false,
              autoAllowed: false,
              approvedBatches: 0,
              pending: [],
            },
          },
        ]),
      );
      const listeners = new Set();
      window.worklens.onChat = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      function emit(view) {
        view.revision++;
        for (const listener of listeners)
          listener({
            conversationId: view.id,
            runId: view.runId,
            sequence: view.revision,
            type: "connector_consent",
            view: structuredClone(view),
          });
      }
      window.jevFixtureFinish = (
        status = "success",
        id = "sample-chat",
        answers = { note1: { type: "choice", choice: "product" } },
      ) => {
        const view = views[id];
        view.phase = "completed";
        view.jevConsent.pending = [];
        view.messages = [
          view.messages[0],
          {
            id: "jev-tool",
            role: "tool",
            toolName: "jev_classify",
            toolId: "sample-tool",
            status: status === "error" ? "error" : "success",
            text: JSON.stringify({
              status,
              purpose: "classify",
              answers,
            }),
          },
          {
            id: "answer",
            role: "assistant",
            text: "The sample feedback is grouped.",
          },
        ];
        emit(view);
      };
      window.jevFixtureRequest = (id = "sample-chat") => {
        const view = views[id];
        if (view.jevConsent.blocked) return;
        if (view.jevConsent.autoAllowed) {
          window.jevFixtureFinish("success", id);
          return;
        }
        view.phase = "tool";
        view.runId = `run-${id}`;
        const requestId = crypto.randomUUID();
        const body = {
          model: "jev-1.13.0",
          state: {
            items: [
              {
                id: "note1",
                text: "The sample lamp arrived with a loose switch.",
              },
              { id: "note2", text: "The sample parcel arrived early." },
            ],
          },
          questions: Object.fromEntries(
            ["note1", "note2"].map((id) => [
              id,
              {
                type: "choice",
                instructions: `Classify ${id}`,
                criteria: {
                  product: "Product feedback",
                  delivery: "Delivery feedback",
                },
              },
            ]),
          ),
        };
        view.jevConsent.pending = [
          {
            id: requestId,
            conversationId: id,
            toolCallId: "sample-tool",
            purpose: "classify",
            endpoint: "https://api.typesafe.ai/v1/systemone",
            itemCount: 2,
            payload: JSON.stringify(body, null, 2),
          },
        ];
        emit(view);
      };
      window.worklens.invoke = async (name, input) => {
        if (
          [
            "jevSave",
            "jevTest",
            "jevRemove",
            "jevConsentReply",
            "jevConsentReset",
            "open",
          ].includes(name)
        ) {
          window.calls.push({ name, input });
          if (name === "open") return structuredClone(views[input.id]);
          if (name === "jevTest") return "TypeSafe";
          if (name === "jevSave") {
            jev = { url: input.url, configured: true };
            return structuredClone(jev);
          }
          if (name === "jevRemove") {
            jev = undefined;
            return;
          }
          const view = views[input.conversationId];
          if (name === "jevConsentReset")
            view.jevConsent = {
              blocked: input.blocked,
              autoAllowed: false,
              approvedBatches: 0,
              pending: [],
            };
          else {
            if (window.failJevReply) throw new Error("Fixture approval failed");
            if (view.jevConsent.pending[0]?.id !== input.requestId)
              throw new Error("Approval expired");
            await new Promise((resolve) => setTimeout(resolve, 120));
            view.jevConsent.pending = [];
            view.jevConsent.blocked = !input.allow;
            view.jevConsent.autoAllowed = !!(input.allow && input.autoAllow);
            if (input.allow) view.jevConsent.approvedBatches++;
            window.jevFixtureFinish(
              input.allow ? "success" : "not_sent",
              view.id,
            );
          }
          if (view.runId) emit(view);
          return structuredClone(view);
        }
        const result = await invoke(name, input);
        if (name === "bootstrap") {
          result.settings.theme = theme;
          result.jev = jev;
          result.tavily = {
            url: "https://api.tavily.com",
            configured: true,
            plan: "dev",
          };
          result.github = {
            url: "https://github.com",
            configured: true,
            login: "sample-user",
          };
          result.jira = {
            url: "https://issues.example.test",
            configured: true,
            deployment: "data-center",
            tokenType: "classic",
          };
          result.confluenceSites = [
            {
              id: "primary",
              readOnly: false,
              url: "https://wiki.example.test",
              configured: true,
              deployment: "data-center",
              tokenType: "classic",
            },
          ];
          if (conversation) {
            result.conversations = Object.values(views);
            result.settings.lastConversation = "sample-chat";
          }
        }
        return result;
      };
    },
    { language, theme, connected, conversation },
  );
}

export async function openConnectors(page, language = "en") {
  await page
    .getByRole("button", {
      name: language === "en" ? "Settings" : "设置",
      exact: true,
    })
    .click();
  await page
    .locator(".settings-navigation")
    .getByRole("button", {
      name: language === "en" ? "Connectors" : "连接器",
      exact: true,
    })
    .click();
  return page.locator('[data-section="connections"]');
}
