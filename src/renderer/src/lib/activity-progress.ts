import type { MessageView } from "../../../shared/contracts";

export function toolProgress(message: MessageView, language: "en" | "zh"): string {
  const zh = language === "zh";
  const name = message.toolName ?? "tool";
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(message.args ?? "{}"); } catch { /* Streaming arguments may be incomplete. */ }
  if (!args || typeof args !== "object") args = {};
  const detail = [args.query, args.q, args.path, message.targetPath].find((value) => typeof value === "string" && value.trim());
  const done = message.status === "success";
  const verb = /search/i.test(name) ? (zh ? (done ? "已搜索" : "正在搜索") : (done ? "Searched" : "Searching"))
    : name === "read" ? (zh ? (done ? "已读取" : "正在读取") : (done ? "Read" : "Reading"))
    : (zh ? (done ? `已完成 ${name}` : `正在运行 ${name}`) : (done ? `Completed ${name}` : `Running ${name}`));
  if (["error", "timeout", "cancelled"].includes(message.status ?? "")) {
    return zh ? `${name}：${message.status === "cancelled" ? "已取消" : message.status === "timeout" ? "已超时" : "失败"}`
      : `${name}: ${message.status}`;
  }
  return detail ? `${verb} · ${String(detail).replace(/\s+/g, " ").slice(0, 180)}` : verb;
}
