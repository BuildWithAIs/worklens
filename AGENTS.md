# Repository Guidelines

## Project Structure & Module Organization

WorkLens is a desktop working agent built with Electron, React, TypeScript, Tailwind CSS, and Pi Agent.

- `src/main/`: lifecycle, authentication, sessions, storage, and validation; service integrations live in `connectors/<service>/`.
- `src/preload/`: typed Electron bridge; `src/shared/`: IPC and UI contracts.
- `src/renderer/src/`: React components, styles, brand assets, and `i18n/locales/` translations.
- `tests/`: unit/integration tests; `tests/e2e/`: Electron acceptance; `tests/ui/`: browser UI checks.
- `resources/skills/`: bundled agent skills; `build/`: installer icons.
- `website/`: separate website package with its own scripts and README.

## Build, Test, and Development Commands

Use Node.js 24 and npm. Run these from the repository root:

- `npm ci`: install locked dependencies; `node node_modules/electron/install.js`: install the Electron runtime.
- `npm run dev`: launch desktop development.
- `npm run typecheck`: run strict TypeScript checks.
- `npm test`: run Vitest tests.
- `npm run test:e2e`: build and run Playwright Electron tests.
- `npm run test:ui`: build and run browser UI tests; requires Chrome.
- `npm run build`, then `npm start`: build and launch production code.
- `npm run pack`: create an unpacked application; `npm run dist:win` / `npm run dist:mac`: create installers in `release/` (build macOS installers on macOS).

## Coding Style & Naming Conventions

Follow surrounding code: two-space indentation, double quotes, semicolons, and trailing commas. Use PascalCase for components/types, camelCase for functions/variables, and kebab-case for service files such as `agent-service.ts`. Keep shared contracts in `src/shared/`. Update both English and Chinese locales for UI text.

Prettier is installed: `npx prettier --write <file>`. No dedicated lint script is configured.

## UI Writing

- Keep contributor and agent instructions here. `docs/` is for user-facing documentation; do not add internal writing guides or review reports there.
- Use concise, natural language and sentence case. Buttons use action verbs (`Save`, `Select models`); routine errors use `Couldn’t [action]` with a known recovery step. Do not invent causes or recovery guarantees.
- Use periods for explanatory sentences, none for buttons/headings/short status labels, and `…` for ongoing actions. Preserve product names, interpolation variables, and locale plural forms.
- Keep terminology consistent with the actual UI: `Choose model` selects the current chat model; the provider-level `Manage` button opens its model selection dialog (accessible name: `Manage models: {{provider}}`); `Manage models` in chat opens Models settings. Prefer `Select models to use in chats.` in instructions over introducing `chat menu` or `model picker`.
- Use `Thinking` / `Thinking level` for the control and related errors; retain `Reasoning` for token usage. Use `Test connection`, not speed test. Preserve technical authentication and deployment terms when necessary.
- Show selected/total model counts as `{{count}} / {{total}}`; the selection dialog can use `{{count}} / {{total}} selected` for its draft count.
- Check the string's actual usage and behavior before editing. Empty states give a relevant next step; search-only interfaces must not mention filters. Preserve consequences involving saved changes, credentials, files, requests, and when settings take effect.
- Keep UI copy, accessible labels, and fallback text in locale files. Update English and Chinese together for meaning changes; grammar-only English edits need not alter natural Chinese. Internal code names do not determine product-facing terminology.
- Update affected text assertions and follow the user's verification scope. Remove obsolete keys only after checking direct references and dynamic key construction.

## Testing Guidelines

Name Vitest tests `*.test.ts` and Playwright tests `*.spec.ts`. Add regression coverage for behavior fixes; no numeric coverage threshold is configured. Run focused tests with `npx vitest run tests/core.test.ts` and relevant acceptance suites before submitting.

Use temporary directories and `WORKLENS_TEST_ROOT` for desktop isolation. Local model-server fixtures avoid paid model calls. Packaged tests require `WORKLENS_PACKAGED_EXE`.

## Commit & Pull Request Guidelines

Follow history's `feat:`, `fix:`, `chore:`, and `docs:` prefixes with concise action phrases. Keep commits focused. Describe behavior changes, link relevant issues, list checks performed, and attach screenshots for UI changes. Distinguish local verification from live-service and cross-platform validation.

## Security & Configuration

Keep privileged operations in the main process behind validated IPC. Never log secrets or persist plaintext credentials. Tests must not touch real user sessions. Exclude generated outputs, `reference/`, and local configuration from commits.
