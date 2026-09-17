export async function mockWorklens(page, options = {}) {
  await page.addInitScript((options) => {
    const model = (id, name, provider, available = true) => ({
      id,
      name,
      provider,
      available,
      reasoning: true,
      image: false,
      contextWindow: 128000,
      levels: ["off", "medium", "high"],
    });
    const data = {
      version: "0.1.0",
      settings: {
        version: 1,
        theme: "light",
        riskAccepted: true,
        defaults: { provider: "deepseek", model: "flash", thinking: "medium" },
        hiddenModels: [],
      },
      providers: [
        {
          id: "deepseek",
          name: "DeepSeek",
          configured: true,
          credentialType: "api_key",
          credentialHint: "••••1234",
          methods: [{ type: "api_key", name: "API key", interactive: true }],
          models: [
            model("flash", "DeepSeek V4 Flash", "deepseek"),
            model("pro", "DeepSeek V4 Pro", "deepseek"),
          ],
          connection: {
            ok: true,
            message: "STALE CONNECTION RESULT",
            checkedAt: "2026-09-10T01:13:00Z",
          },
        },
        {
          id: "github-copilot",
          name: "GitHub Copilot",
          configured: true,
          credentialType: "api_key",
          credentialHint: "••••5678",
          methods: [
            { type: "api_key", name: "GitHub token", interactive: true },
            { type: "oauth", name: "Sign in with GitHub", interactive: true },
          ],
          models: [
            model("gpt", "GPT-5", "github-copilot"),
            model("sonnet", "Copilot Sonnet", "github-copilot"),
            model("gemini", "Copilot Gemini", "github-copilot"),
            model("restricted", "Restricted model", "github-copilot", false),
          ],
        },
        {
          id: "anthropic",
          name: "Anthropic",
          configured: false,
          methods: [
            { type: "api_key", name: "API key", interactive: true },
            { type: "oauth", name: "Claude subscription", interactive: true },
          ],
          models: [model("sonnet", "Claude Sonnet", "anthropic", false)],
        },
        {
          id: "openai",
          name: "OpenAI",
          configured: false,
          methods: [{ type: "api_key", name: "API key", interactive: true }],
          models: [model("gpt", "GPT-5", "openai", false)],
        },
      ],
      conversations: [],
      recoveries: [],
      diagnostics: [],
      paths: {
        root: "/Users/example/WorkLens",
        runtime: "/Users/example",
        sessions: "/Users/example/WorkLens/sessions",
        userData: "/Users/example/Library/Application Support/WorkLens",
        skills: "/Users/example/WorkLens/skills",
      },
    };
    let skillId = 0;
    const skill = (name, source, summary, enabled = true) => ({
      id: (++skillId).toString(16).padStart(64, "0"),
      name,
      source,
      summary,
      description: `${summary} Much longer guidance follows for the model.`,
      path: `/Users/example/${source}/${name}/SKILL.md`,
      enabled,
    });
    const skills = {
      builtin: [
        skill("example-guide", "builtin", "Example built-in instructions.", false),
      ],
      local: [
        skill("brave-search", "local", "Web search."),
        skill("pdf-tools", "local", "Extracts text from PDFs.", false),
      ],
    };
    data.providers.push({
      id: "azure-openai-responses",
      name: "Azure OpenAI",
      configured: true,
      credentialType: "api_key",
      credentialHint: "••••AZUR",
      methods: [{ type: "api_key", name: "Azure API key", interactive: true }],
      models: [model("gpt", "Azure GPT", "azure-openai-responses")],
    });
    data.providers.push({
      id: "bedrock",
      name: "Amazon Bedrock",
      configured: false,
      methods: [
        {
          type: "api_key",
          name: "AWS credentials or bearer token",
          interactive: false,
        },
      ],
      models: [],
    });
    data.settings =
      JSON.parse(localStorage.getItem("ui-fixture-settings") ?? "null") ??
      data.settings;
    const selection = data.settings.defaults;
    if (options.modelState) {
      delete data.settings.defaults;
      for (const provider of data.providers) {
        if (options.modelState === "unconfigured") {
          provider.configured = false;
          delete provider.credentialType;
          delete provider.credentialHint;
          delete provider.connection;
        }
        for (const model of provider.models) {
          if (options.modelState === "hidden") {
            data.settings.hiddenModels.push(`${provider.id}/${model.id}`);
          } else {
            model.available = false;
          }
        }
      }
    }
    if (options.unavailableSelection && selection) {
      data.settings.defaults = selection;
      const selectedModel = data.providers
        .find((provider) => provider.id === selection.provider)
        ?.models.find((model) => model.id === selection.model);
      if (selectedModel) selectedModel.available = false;
    }
    let listeners = [],
      pending;
    window.calls = [];
    window.worklens = {
      onChat: () => () => {},
      onAuth: (fn) => {
        listeners.push(fn);
        return () => {
          listeners = listeners.filter((f) => f !== fn);
        };
      },
      invoke: async (name, input) => {
        window.calls.push({ name, input });
        if (name === "bootstrap") return structuredClone(data);
        if (name === "confluenceSave") {
          const { token, ...settings } = input;
          data.confluence = { ...settings, configured: true };
          return structuredClone(data.confluence);
        }
        if (name === "confluenceRemove") { data.confluence = undefined; return; }
        if (name === "confluenceTest") {
          if (!input.url) throw Error("Enter a Confluence URL");
          return `Fixture User · ${input.url}`;
        }
        if (name === "jiraSave") {
          const { token, ...settings } = input;
          data.jira = { ...settings, configured: true };
          return structuredClone(data.jira);
        }
        if (name === "githubSave") {
          if (!input.url) throw Error("Enter a GitHub URL");
          const { token, ...settings } = input;
          data.github = { ...settings, configured: true, login: "fixture-user" };
          return structuredClone(data.github);
        }
        if (name === "githubRemove") { data.github = undefined; return; }
        if (name === "githubTest") {
          if (!input.url) throw Error("Enter a GitHub URL");
          return `fixture-user · ${input.url}`;
        }
        if (name === "skillsList" || name === "skillsRefresh")
          return structuredClone(skills);
        if (name === "skillsToggle") {
          await new Promise((resolve) => setTimeout(resolve, 80));
          for (const item of [...skills.builtin, ...skills.local])
            if (item.id === input.id) item.enabled = input.enabled;
          return structuredClone(skills);
        }
        if (name === "skillsReveal") return;
        if (name === "tavilySave") {
          if (!input.url) throw Error("请填写 Tavily API 地址");
          if (!input.token) throw Error("请填写 Tavily API key");
          data.tavily = { url: input.url, configured: true, plan: "dev" };
          return structuredClone(data.tavily);
        }
        if (name === "tavilyRemove") { data.tavily = undefined; return; }
        if (name === "tavilyTest") {
          if (!input.token) throw Error("请填写 Tavily API key");
          return "Tavily 已连接：dev";
        }
        if (name === "jiraRemove") { data.jira = undefined; return; }
        if (name === "jiraTest") {
          if (!input.url) throw Error("Enter a Jira URL");
          return `Fixture User · ${input.url}`;
        }
        if (name === "settings") {
          await new Promise((resolve) => setTimeout(resolve, 120));
          if (input.hiddenModels && window.failNextVisibilitySave) {
            window.failNextVisibilitySave = false;
            throw Error("Could not save visibility");
          }
          Object.assign(data.settings, input);
          localStorage.setItem(
            "ui-fixture-settings",
            JSON.stringify(data.settings),
          );
          return structuredClone(data.settings);
        }
        if (name === "login") {
          return new Promise((resolve, reject) => {
            pending = { input, resolve, reject };
            if (input.type === "oauth")
              listeners.forEach((fn) =>
                fn({
                  loginId: input.loginId,
                  type: "device_code",
                  message: "在浏览器中输入设备码完成登录",
                  userCode: "DEMO-CODE",
                }),
              );
            setTimeout(
              () =>
                listeners.forEach((fn) =>
                  fn({
                    loginId: input.loginId,
                    promptId: "p1",
                    type: input.type === "api_key" ? "secret" : "select",
                    message:
                      input.type === "api_key"
                        ? "API key"
                        : "GitHub deployment",
                    options: [
                      { id: "public", label: "GitHub.com" },
                      { id: "enterprise", label: "GitHub Enterprise" },
                    ],
                  }),
                ),
              30,
            );
          });
        }
        if (name === "authCancel") {
          pending?.reject(Error("Cancelled"));
          pending = undefined;
          return;
        }
        if (name === "authReply") {
          const p = data.providers.find((p) => p.id === pending.input.provider);
          p.configured = true;
          p.credentialType = pending.input.type;
          p.models.forEach((m) => (m.available = m.id !== "restricted"));
          pending.resolve();
          pending = undefined;
          return;
        }
        if (name === "logout") {
          const p = data.providers.find((p) => p.id === input.provider);
          p.configured = false;
          delete p.credentialType;
          delete p.credentialHint;
          p.models.forEach((m) => (m.available = false));
          return;
        }
        if (name === "test") return "Connection success";
        if (name === "refreshModels") return "Existing 3 models (unchanged)";
      },
    };
  }, options);
}

export async function mockExistingConversation(page) {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    const view = { id: "existing", title: "Existing conversation", phase: "completed", messages: [{ id: "user", role: "user", text: "Hello" }], updatedAt: "2026-09-13T00:00:00Z" };
    window.worklens.invoke = async (name, input) => {
      if (name === "open") return view;
      const result = await invoke(name, input);
      if (name === "bootstrap") { result.conversations = [view]; result.settings.lastConversation = view.id; }
      return result;
    };
  });
}
