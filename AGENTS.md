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

## Testing Guidelines

Name Vitest tests `*.test.ts` and Playwright tests `*.spec.ts`. Add regression coverage for behavior fixes; no numeric coverage threshold is configured. Run focused tests with `npx vitest run tests/core.test.ts` and relevant acceptance suites before submitting.

Use temporary directories and `WORKLENS_TEST_ROOT` for desktop isolation. Local model-server fixtures avoid paid model calls. Packaged tests require `WORKLENS_PACKAGED_EXE`.

## Commit & Pull Request Guidelines

Follow history's `feat:`, `fix:`, `chore:`, and `docs:` prefixes with concise action phrases. Keep commits focused. Describe behavior changes, link relevant issues, list checks performed, and attach screenshots for UI changes. Distinguish local verification from live-service and cross-platform validation.

## Security & Configuration

Keep privileged operations in the main process behind validated IPC. Never log secrets or persist plaintext credentials. Tests must not touch real user sessions. Exclude generated outputs, `reference/`, and local configuration from commits.
