import type { MessageView } from "../../../shared/contracts";

function progressDetail(args: Record<string, unknown>): string | undefined {
  for (const key of ["query", "q", "search_query", "search_term", "search_terms", "keywords", "queries", "searches", "path", "url", "command"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value)) {
      const details = value.map((item) => typeof item === "string" ? item
        : item && typeof item === "object" ? progressDetail(item) : undefined).filter(Boolean);
      if (details.length) return details.join(" · ");
    }
  }
  return undefined;
}

export function toolProgress(message: MessageView, language: "en" | "zh"): string {
  const zh = language === "zh";
  const name = message.toolName ?? "tool";
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(message.args ?? "{}"); } catch { /* Streaming arguments may be incomplete. */ }
  if (!args || typeof args !== "object") args = {};
  const detail = progressDetail(args) || message.targetPath;
  const done = message.status === "success";
  const verb = /search/i.test(name) ? (zh ? (done ? "已搜索" : "正在搜索") : (done ? "Searched" : "Searching"))
    : name === "read" ? (zh ? (done ? "已读取" : "正在读取") : (done ? "Read" : "Reading"))
    : (zh ? (done ? `已完成 ${name}` : `正在运行 ${name}`) : (done ? `Completed ${name}` : `Running ${name}`));
  if (["error", "timeout", "cancelled"].includes(message.status ?? "")) {
    return zh ? `${name}：${message.status === "cancelled" ? "已取消" : message.status === "timeout" ? "已超时" : "失败"}`
      : `${name}: ${message.status}`;
  }
  const compactDetail = detail?.replace(/\s+/g, " ").trim();
  // Command previews use the available row width; CSS supplies the ellipsis.
  const limit = /bash|powershell|shell|exec|terminal/i.test(name) ? Infinity : 180;
  return compactDetail ? `${verb} · ${compactDetail.length > limit ? `${compactDetail.slice(0, limit)}…` : compactDetail}` : verb;
}

// Presentation labels only; full arguments remain in toolProgress and tool details.
export function toolActivityLabel(name: string, detail: string, active: boolean, language: "en" | "zh") {
  const zh = language === "zh";
  if (/(: error|：失败)$/.test(detail)) return zh ? "工具执行失败" : "Tool failed";
  if (/(: timeout|：已超时)$/.test(detail)) return zh ? "工具执行超时" : "Tool timed out";
  if (/(: cancelled|：已取消)$/.test(detail)) return zh ? "工具已取消" : "Tool cancelled";
  if (active && detail) return detail;
  const labels = /search|browse|web|fetch/i.test(name)
    ? ["Searching", "Searched", "正在搜索", "已搜索"]
    : /read|open_file/i.test(name)
      ? ["Reading file", "Read file", "正在读取文件", "已读取文件"]
      : /bash|powershell|shell|exec|terminal/i.test(name)
        ? ["Running command", "Ran command", "正在运行命令", "已运行命令"]
        : /write|edit|patch/i.test(name)
          ? ["Editing file", "Edited file", "正在编辑文件", "已编辑文件"]
          : /image|screenshot/i.test(name)
            ? ["Viewing image", "Viewed image", "正在查看图片", "已查看图片"]
            : /grep|find|^ls$|list_directory/i.test(name)
              ? ["Searching files", "Searched files", "正在查找文件", "已查找文件"]
              : ["Running tool", "Used tool", "正在运行工具", "已使用工具"];
  return labels[(zh ? 2 : 0) + (active ? 0 : 1)];
}


// Aggregate only the tools between two narration messages; never infer their intent.
export function toolActivitySummary(messages: MessageView[], language: "en" | "zh"): string | undefined {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    const label = toolActivityLabel(message.toolName ?? "tool", toolProgress(message, language), false, language);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const plurals: Record<string, string> = {
    "Ran command": "Ran commands", "Read file": "Read files",
    "Edited file": "Edited files", "Viewed image": "Viewed images", "Used tool": "Used tools",
  };
  const labels = [...counts].map(([label, count]) => count > 1 ? plurals[label] ?? label : label);
  return labels.length ? labels.map((label, index) => index && language === "en" ? label[0].toLowerCase() + label.slice(1) : label).join(language === "zh" ? "、" : ", ") : undefined;
}
