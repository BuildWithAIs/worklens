import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const output = new URL("../.output/public/", import.meta.url);
const publicDirectory = new URL("../public/", import.meta.url);
const requiredFiles = [
  "index.html",
  "404.html",
  "_headers",
  "robots.txt",
  "sitemap.xml",
  "assets/icon.png",
  "assets/worklens.png",
];

await Promise.all(requiredFiles.map((file) => access(new URL(file, output))));

for (const asset of ["assets/icon.png", "assets/worklens.png"]) {
  const [sourceBytes, outputBytes] = await Promise.all([
    readFile(new URL(asset, publicDirectory)),
    readFile(new URL(asset, output)),
  ]);

  if (!sourceBytes.equals(outputBytes)) {
    throw new Error(`Static build changed the bytes of ${asset}`);
  }
}

const html = await readFile(new URL("index.html", output), "utf8");
const requiredText = [
  "WorkLens · 让工作，从这里继续",
  "本地优先的桌面工作 Agent",
  "从对话到行动。",
  "带上你的模型",
  "WorkLens 是什么？",
];

for (const text of requiredText) {
  if (!html.includes(text)) {
    throw new Error(`Prerendered index is missing: ${text}`);
  }
}

if (/tanstack-start-example|SaaS Starter|localhost:3000/.test(html)) {
  throw new Error(
    "Prerendered index contains template or development metadata",
  );
}

if (/\/api\//.test(html)) {
  throw new Error("Static homepage unexpectedly references an API route");
}

const outputPath = join(output.pathname, "index.html");
console.log(`Verified prerendered static homepage: ${outputPath}`);
