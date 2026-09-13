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
