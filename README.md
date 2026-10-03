# WorkLens

English | [简体中文](README.zh-CN.md)

[Website](https://worklens.buildwithais.com/) · [Website deployment](website/README.md)

WorkLens is a local-first work agent for employees at larger companies — especially teams that rely on Jira, Confluence, GitHub, and similar enterprise services. Memory is on the roadmap, and it will make WorkLens understand you better over time.

Built with Electron, React, TypeScript, Tailwind CSS, and Pi.

## Confluence

Connect one Confluence site in **Settings → Connections** using your URL and token. Search/read documents, make version-aware edits, publish Markdown with attachments, and download/export files into the current conversation. Cloud supports email/API-token authentication; Data Center supports PAT authentication.

## GitHub

Connect one GitHub site in **Settings → Connections** by entering its URL and a Personal Access Token. The address starts empty and supports your company's GitHub instance as well as GitHub.com. Explore code, manage issues and PRs, review changes, investigate CI, maintain releases, and work with Projects and Discussions. The integration uses Octokit and requires no GitHub CLI installation.

## Web search (Tavily)

Connect Tavily in **Settings → Connectors** with an API key to give the agent `web_search`, `web_fetch`, and Tavily deep research.

## MCP and Code Mode

In **Settings → Connectors → MCP**, choose **Add connection**. Use **Manual setup** to enter a name and the service’s MCP address or local program details, or use **Import JSON** to import an `mcpServers` configuration. Names use 1–80 letters, numbers, `-` or `_`. Importing adds connections and keeps existing ones; names must have distinct tool namespaces. After adding a connection, sign in if required, then open **Manage** and use **Test connection**. Each connection can be managed or deleted separately. The global Code Mode switch is in **Settings → General → Tool execution** and applies to built-in and MCP tools.

For **Remote service**, choose Atlassian (Jira / Confluence Cloud), Notion, Linear, GitHub, or Sentry to prefill the name and official MCP address. **Other service** lets you enter a custom address. Presets do not confirm connectivity. For [GitHub](https://github.com/github/github-mcp-server), enter `Bearer <personal-access-token>` in the Authorization field. Other presets use browser sign-in where available; organization policies may apply.

WorkLens supports stdio and streamable HTTP servers, HTTP headers or provider credentials, and browser OAuth with a loopback callback. Saved settings and OAuth credentials use OS encryption. The JSON editor shows `<saved>` for stored values; keep the placeholder to reuse a credential for the same server. Use `${ENV_NAME}` in headers and environment values to read an environment variable when connecting.

```json
{
  "mcpServers": {
    "local": {
      "command": "node",
      "args": ["/absolute/path/to/server.mjs"],
      "exposure": "codemode"
    },
    "remote": {
      "url": "https://your-server.example/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" },
      "exposure": "deferred"
    }
  }
}
```

Code Mode is enabled by default. It lets the agent combine existing tools in JavaScript, including parallel calls and filtering results. Nested calls keep the same tool validation, connector consent, file scheduling and cancellation behavior; their results remain visible in the conversation after restart. JavaScript runs in a QuickJS sandbox; calls to file, command and MCP tools can still affect your computer and external services. Install and configure servers you trust. Put credentials in `env`, `headers` or OAuth settings rather than command arguments or URLs.

`exposure` accepts `codemode`, `deferred` (loaded through `tool_search`), `direct` (declared immediately), or `hidden`. `toolExposure` overrides individual tools, and `enabled: false` disables a server. MCP resources are available through the resource tools. Disabling Code Mode changes `codemode` exposure to `deferred`; MCP tools remain available. Changes apply to each conversation on its next message. HTTP requires HTTPS, with HTTP allowed for loopback servers. Legacy SSE transport is not supported.

## Local development

Requires Node.js 24 and npm.

```sh
npm ci
node node_modules/electron/install.js
npm run dev
```

To run a production build:

```sh
npm run build
npm start
```

On first launch you land in Settings: choose a provider → complete the authentication flow → select and save a default model → test the connection → start a new session.

## Verification and packaging

```sh
npm run typecheck
npm test
npm run test:e2e
npm run pack
npm run dist:win
# build on macOS
npm run dist:mac
```

`npm test` uses the real Pi runtime with the base tools, process execution, and temporary files; model traffic is controlled by a local HTTP test server, so no paid account is needed. `test:e2e` launches a real Electron app through Playwright and covers authentication interactions, OS credential encryption, file tasks, themes, and restarts.

If Electron has already been downloaded, you can keep the packager from downloading it again:

```sh
npm run build
npx electron-builder --win nsis --config.electronDist=node_modules/electron/dist
```

Testing the packaged artifact (PowerShell):

```powershell
$env:WORKLENS_PACKAGED_EXE = 'release/win-unpacked/WorkLens.exe'
npx playwright test tests/e2e/packaged.spec.ts
```

Installers are written to `release/`. By default the build does not upload, publish, or auto-update the app. Before distributing publicly you need your own code signing, macOS notarization, and a clean-environment install verification.

## Source layout

Office integrations are grouped by service under `src/main/connectors/`, with corresponding settings components and tests.

```text
src/main/        app lifecycle, models and auth, session execution, scheduling, storage, input validation
src/preload/     minimal typed Electron bridge
src/shared/      IPC and UI contracts
src/renderer/    React session and settings UI
tests/           local HTTP model test server, real Pi integration, Electron acceptance
build/           installer icons
reference/       local reference clones, not packaged, not committed
```
