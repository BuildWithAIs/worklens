import { stat } from "node:fs/promises";
import { extname } from "node:path";

// Opening these with the default handler can run code: shell scripts, app
// bundles, installers, shortcuts and script hosts. Agent output and connector
// downloads may come from untrusted content, so callers reveal them instead.
const executableExtensions = new Set([
  ".app",
  ".action",
  ".applescript",
  ".appimage",
  ".appref-ms",
  ".bash",
  ".bat",
  ".cmd",
  ".com",
  ".command",
  ".cpl",
  ".csh",
  ".desktop",
  ".exe",
  ".fileloc",
  ".fish",
  ".hta",
  ".inetloc",
  ".inf",
  ".jar",
  ".ksh",
  ".lnk",
  ".mpkg",
  ".msc",
  ".msi",
  ".msp",
  ".pif",
  ".pkg",
  ".prefpane",
  ".ps1",
  ".psm1",
  ".reg",
  ".run",
  ".scpt",
  ".scptd",
  ".scr",
  ".settingcontent-ms",
  ".sh",
  ".terminal",
  ".tool",
  ".url",
  ".vb",
  ".vbe",
  ".vbs",
  ".webloc",
  ".workflow",
  ".ws",
  ".wsf",
  ".wsh",
  ".zsh",
]);
// Windows runs these through script hosts; other systems open an editor.
const windowsScriptExtensions = new Set([".js", ".jse", ".py", ".pyw"]);

export async function isExecutableFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
) {
  const extension = extname(path).toLowerCase();
  if (executableExtensions.has(extension)) return true;
  if (platform === "win32") return windowsScriptExtensions.has(extension);
  // Finder and desktop launchers run Unix executables in a terminal.
  const info = await stat(path).catch(() => undefined);
  return !!info?.isFile() && (info.mode & 0o111) !== 0;
}
