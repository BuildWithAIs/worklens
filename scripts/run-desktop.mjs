import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const mode = process.argv[2] ?? "dev";
let executable = require("electron");
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
};
if (process.platform === "darwin") {
  const version = require("electron/package.json").version;
  const runtime = join(root, "node_modules", ".worklens-electron", version);
  const bundle = join(runtime, "WorkLens.app");
  const ready = join(runtime, "ready-v1");
  const iconHash = createHash("sha256").update(readFileSync(join(root, "build/icon.icns"))).digest("hex");
  if (!existsSync(ready) || readFileSync(ready, "utf8") !== iconHash) {
    mkdirSync(runtime, { recursive: true });
    if (!existsSync(bundle)) run("/bin/cp", ["-R", resolve(executable, "../../.."), bundle]);
    const plist = join(bundle, "Contents", "Info.plist");
    for (const [key, value] of Object.entries({ CFBundleName: "WorkLens", CFBundleDisplayName: "WorkLens", CFBundleIdentifier: "com.buildwithais.worklens.dev" })) {
      run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
    }
    run("/bin/cp", [join(root, "build", "icon.icns"), join(bundle, "Contents", "Resources", "electron.icns")]);
    run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle]);
    writeFileSync(ready, iconHash);
  }
  executable = join(bundle, "Contents", "MacOS", "Electron");
}
if (mode === "prepare") { console.log(executable); process.exit(0); }
if (!["dev", "start"].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
const env = { ...process.env, ELECTRON_EXEC_PATH: executable };
delete env.ELECTRON_RUN_AS_NODE;
const child = mode === "dev"
  ? spawn(process.execPath, [join(root, "node_modules/electron-vite/bin/electron-vite.js"), "dev", ...process.argv.slice(3)], { cwd: root, env, stdio: "inherit" })
  : spawn(executable, [root, ...process.argv.slice(3)], { cwd: root, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 0; });
