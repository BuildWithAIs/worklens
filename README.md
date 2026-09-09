# WorkLens

WorkLens is a working agent built to serve employees at relatively large enterprises and to genuinely "understand" them.

[中文说明](README.zh-CN.md)

Built with Electron, React, TypeScript, Tailwind CSS, and Pi.

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

```text
src/main/        app lifecycle, models and auth, session execution, scheduling, storage, input validation
src/preload/     minimal typed Electron bridge
src/shared/      IPC and UI contracts
src/renderer/    React session and settings UI
tests/           local HTTP model test server, real Pi integration, Electron acceptance
build/           installer icons
reference/       local reference clones, not packaged, not committed
```
