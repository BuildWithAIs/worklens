import { expect, test } from "vitest";
import { toolProgress, toolActivityLabel, toolActivitySummary } from "../src/renderer/src/lib/activity-progress";

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


test("compact activity labels cover tool families and preserve exceptional states", () => {
  for (const [name, running, done] of [
    ["bash", "Running command", "Ran command"],
    ["read", "Reading file", "Read file"],
    ["web_search", "Searching", "Searched"],
    ["edit", "Editing file", "Edited file"],
    ["view_image", "Viewing image", "Viewed image"],
    ["grep", "Searching files", "Searched files"],
    ["future_connector", "Running tool", "Used tool"],
  ]) {
    expect(toolActivityLabel(name, "", true, "en")).toBe(running);
    expect(toolActivityLabel(name, "", false, "en")).toBe(done);
  }
  expect(toolActivityLabel("bash", "bash: error", false, "en")).toBe("Tool failed");
  expect(toolActivityLabel("bash", "bash: timeout", false, "en")).toBe("Tool timed out");
  expect(toolActivityLabel("bash", "bash：已取消", false, "zh")).toBe("工具已取消");
  expect(toolActivityLabel("read", "", true, "zh")).toBe("正在读取文件");
});


test("completed intervals aggregate actual tool types and retain failures", () => {
  const tool = (toolName: string, status: "success" | "error" = "success") => ({ id: toolName, role: "tool" as const, text: "", toolName, status });
  expect(toolActivitySummary([tool("read"), tool("read"), tool("bash")], "en")).toBe("Read files, ran command");
  expect(toolActivitySummary([tool("bash"), tool("bash")], "en")).toBe("Ran commands");
  expect(toolActivitySummary([tool("read"), tool("bash", "error")], "en")).toBe("Read file, tool failed");
  expect(toolActivitySummary([tool("read"), tool("bash")], "zh")).toBe("已读取文件、已运行命令");
  expect(toolActivityLabel("bash", "Running bash · echo hello", true, "en")).toBe("Running bash · echo hello");
});
