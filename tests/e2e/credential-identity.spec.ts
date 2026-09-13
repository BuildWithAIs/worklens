import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

test("existing encrypted credentials survive desktop branding and restart", async () => {
  test.skip(process.platform !== "darwin", "macOS Keychain identity regression");
  // Launch normally: Playwright's Electron loader enables a mock Keychain,
  // which cannot validate compatibility with credentials from normal launches.
  const directory = await mkdtemp(join(tmpdir(), "worklens-identity-"));
  const fixture = join(directory, "fixture");
  const vault = join(directory, "app", "credentials");
  await mkdir(fixture, { recursive: true });
  await mkdir(vault, { recursive: true });
  const path = join(vault, `${createHash("sha256").update("deepseek").digest("hex")}.json`);
  const resultPath = join(directory, "result.json");
  const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  await writeFile(join(fixture, "package.json"), JSON.stringify({ name: "worklens", version: "0.0.0", main: "main.cjs" }));
  await writeFile(join(fixture, "main.cjs"), `
    const { app, safeStorage } = require('electron');
    app.setPath('userData', ${JSON.stringify(join(directory, "legacy-data"))});
    app.whenReady().then(() => {
      require('node:fs').writeFileSync(${JSON.stringify(path)}, JSON.stringify({
        version: 1, provider: 'deepseek',
        encrypted: safeStorage.encryptString(JSON.stringify({type: 'api_key', key: 'non-secret-regression-fixture'})).toString('base64')
      }), {mode: 0o600});
      app.quit();
    });
  `);
  try {
    const originalExecutable = createRequire(import.meta.url)("electron");
    await exec(originalExecutable, [fixture], { env, timeout: 30000 });
    const original = await readFile(path);
    const { stdout } = await exec(process.execPath, ["scripts/run-desktop.mjs", "prepare"], { cwd: resolve(".") });
    await writeFile(join(fixture, "package.json"), JSON.stringify({ name: "worklens", version: "0.0.0", main: "main.mjs" }));
    await writeFile(join(fixture, "main.mjs"), `
      import { app } from 'electron';
      import { writeFileSync } from 'node:fs';
      app.setAppPath(${JSON.stringify(resolve("."))});
      app.on('browser-window-created', (_event, window) => {
        window.webContents.once('did-finish-load', async () => {
          try {
            const result = await window.webContents.executeJavaScript(\`window.worklens.invoke('bootstrap', undefined).then(data => {
              const p = data.providers.find(p => p.id === 'deepseek');
              return { configured: p.configured, error: !!p.credentialError, available: p.models.some(m => m.available) };
            })\`);
            writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
          } finally { app.quit(); }
        });
      });
      await import(${JSON.stringify(pathToFileURL(resolve("dist/main/index.js")).href)});
    `);
    for (let attempt = 0; attempt < 2; attempt++) {
      await rm(resultPath, { force: true });
      await exec(stdout.trim(), [fixture], { env, timeout: 30000 });
      expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({ configured: true, error: false, available: true });
      expect(await readFile(path)).toEqual(original);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
