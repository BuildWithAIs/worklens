import { expect, test } from "vitest";
import { toolProgress } from "../src/renderer/src/lib/activity-progress";

test("search progress includes nested queries and bounds long details", () => {
  const message = { id: "search", role: "tool" as const, text: "", toolName: "web_search", status: "running" as const };
  expect(toolProgress({ ...message, args: JSON.stringify({ search_query: [{ q: "天气 南京" }] }) }, "zh"))
    .toBe("正在搜索 · 天气 南京");
  expect(toolProgress({ ...message, args: JSON.stringify({ queries: ["one", "two"] }) }, "en"))
    .toBe("Searching · one · two");
  expect(toolProgress({ ...message, args: JSON.stringify({ query: "x".repeat(200) }) }, "en"))
    .toBe(`Searching · ${"x".repeat(180)}…`);
  expect(toolProgress({ ...message, args: '{"query":' }, "en")).toBe("Searching");
});

test("shell progress includes the command instead of only the tool name", () => {
  const message = { id: "shell", role: "tool" as const, text: "", toolName: "bash", status: "running" as const,
    args: JSON.stringify({ command: "rg --files\n  src" }) };
  expect(toolProgress(message, "en")).toBe("Running bash · rg --files src");
  expect(toolProgress({ ...message, args: JSON.stringify({ command: "x".repeat(200) }) }, "en"))
    .toBe(`Running bash · ${"x".repeat(200)}`);
  expect(toolProgress({ ...message, toolName: "powershell", status: "success" }, "zh"))
    .toBe("已完成 powershell · rg --files src");
});
