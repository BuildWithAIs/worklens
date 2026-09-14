import i18n, { type AppLanguage } from "../i18n";
import type { MessageView } from "../../../shared/contracts";

type ActivityKind =
  | "search"
  | "read"
  | "command"
  | "edit"
  | "image"
  | "files"
  | "tool";
type SummaryKind =
  | "searched"
  | "readFile"
  | "ranCommand"
  | "editedFile"
  | "viewedImage"
  | "searchedFiles"
  | "usedTool"
  | "toolFailed"
  | "toolTimedOut"
  | "toolCancelled";

const labelKeys = {
  search: ["activity.label.searching", "activity.label.searched"],
  read: ["activity.label.readingFile", "activity.label.readFile"],
  command: ["activity.label.runningCommand", "activity.label.ranCommand"],
  edit: ["activity.label.editingFile", "activity.label.editedFile"],
  image: ["activity.label.viewingImage", "activity.label.viewedImage"],
  files: ["activity.label.searchingFiles", "activity.label.searchedFiles"],
  tool: ["activity.label.runningTool", "activity.label.usedTool"],
} as const;

const summaryKeys = {
  searched: "activity.summary.searched",
  readFile: "activity.summary.readFile",
  ranCommand: "activity.summary.ranCommand",
  editedFile: "activity.summary.editedFile",
  viewedImage: "activity.summary.viewedImage",
  searchedFiles: "activity.summary.searchedFiles",
  usedTool: "activity.summary.usedTool",
  toolFailed: "activity.summary.toolFailed",
  toolTimedOut: "activity.summary.toolTimedOut",
  toolCancelled: "activity.summary.toolCancelled",
} as const;

const completedSummaryKinds: Record<ActivityKind, SummaryKind> = {
  search: "searched",
  read: "readFile",
  command: "ranCommand",
  edit: "editedFile",
  image: "viewedImage",
  files: "searchedFiles",
  tool: "usedTool",
};

function progressDetail(args: Record<string, unknown>): string | undefined {
  for (const key of [
    "query",
    "q",
    "search_query",
    "search_term",
    "search_terms",
    "keywords",
    "queries",
    "searches",
    "path",
    "url",
    "command",
  ]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value)) {
      const details = value
        .map((item) =>
          typeof item === "string"
            ? item
            : item && typeof item === "object"
              ? progressDetail(item as Record<string, unknown>)
              : undefined,
        )
        .filter(Boolean);
      if (details.length) return details.join(" · ");
    }
  }
  return undefined;
}

function activityKind(name: string): ActivityKind {
  if (/search|browse|web|fetch/i.test(name)) return "search";
  if (/read|open_file/i.test(name)) return "read";
  if (/bash|powershell|shell|exec|terminal/i.test(name)) return "command";
  if (/write|edit|patch/i.test(name)) return "edit";
  if (/image|screenshot/i.test(name)) return "image";
  if (/grep|find|^ls$|list_directory/i.test(name)) return "files";
  return "tool";
}

function exceptionalKind(detail: string): SummaryKind | undefined {
  if (/(: error|：失败)$/.test(detail)) return "toolFailed";
  if (/(: timeout|：已超时)$/.test(detail)) return "toolTimedOut";
  if (/(: cancelled|：已取消)$/.test(detail)) return "toolCancelled";
  return undefined;
}

export function toolProgress(
  message: MessageView,
  language: AppLanguage,
): string {
  const t = i18n.getFixedT(language);
  const name = message.toolName ?? "tool";
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(message.args ?? "{}");
  } catch {
    // Streaming arguments may be incomplete.
  }
  if (!args || typeof args !== "object") args = {};
  const detail = progressDetail(args) || message.targetPath;
  const done = message.status === "success";
  const verb = /search/i.test(name)
    ? t(done ? "activity.progress.searched" : "activity.progress.searching")
    : name === "read"
      ? t(done ? "activity.progress.read" : "activity.progress.reading")
      : t(
          done
            ? "activity.progress.completedTool"
            : "activity.progress.runningTool",
          { name },
        );

  if (message.status === "error") return t("activity.progress.error", { name });
  if (message.status === "timeout")
    return t("activity.progress.timeout", { name });
  if (message.status === "cancelled")
    return t("activity.progress.cancelled", { name });

  const compactDetail = detail?.replace(/\s+/g, " ").trim();
  // Command previews use the available row width; CSS supplies the ellipsis.
  const limit = /bash|powershell|shell|exec|terminal/i.test(name)
    ? Infinity
    : 180;
  const visibleDetail =
    compactDetail && compactDetail.length > limit
      ? `${compactDetail.slice(0, limit)}…`
      : compactDetail;
  return visibleDetail ? `${verb} · ${visibleDetail}` : verb;
}

// Presentation labels only; full arguments remain in toolProgress and tool details.
export function toolActivityLabel(
  name: string,
  detail: string,
  active: boolean,
  language: AppLanguage,
) {
  const t = i18n.getFixedT(language);
  const exceptional = exceptionalKind(detail);
  if (exceptional === "toolFailed") return t("activity.label.toolFailed");
  if (exceptional === "toolTimedOut") return t("activity.label.toolTimedOut");
  if (exceptional === "toolCancelled") return t("activity.label.toolCancelled");
  if (active && detail) return detail;
  return t(labelKeys[activityKind(name)][active ? 0 : 1]);
}

// Aggregate only the tools between two narration messages; never infer their intent.
export function toolActivitySummary(
  messages: MessageView[],
  language: AppLanguage,
): string | undefined {
  const t = i18n.getFixedT(language);
  const counts = new Map<SummaryKind, number>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    const detail = toolProgress(message, language);
    const kind =
      exceptionalKind(detail) ??
      completedSummaryKinds[activityKind(message.toolName ?? "tool")];
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const labels = [...counts].map(([kind, count]) =>
    t(summaryKeys[kind], { count }),
  );
  return labels.length
    ? labels
        .map((label, index) =>
          index && language === "en"
            ? label[0].toLowerCase() + label.slice(1)
            : label,
        )
        .join(language === "zh" ? "、" : ", ")
    : undefined;
}
