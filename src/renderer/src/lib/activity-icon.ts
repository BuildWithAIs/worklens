import {
  BookOpen,
  FilePenLine,
  Globe,
  Images,
  ListFilter,
  SquareTerminal,
  Wrench,
  ScanText,
  RotateCw,
  CircleStop,
  LoaderCircle,
  FolderOpen,
  Database,
  GitBranch,
  Clock,
  CircleAlert,
} from "lucide-react";

// Shared by live status and persisted tool rows; unknown tools always have an icon.
export function activityIcon(name: string) {
  if (name === "thinking") return LoaderCircle;
  if (name === "compacting") return ScanText;
  if (name === "retrying") return RotateCw;
  if (name === "stopping" || name === "cancelled") return CircleStop;
  if (name === "failed" || name === "error") return CircleAlert;
  if (name === "waiting") return Clock;
  if (name === "working") return LoaderCircle;
  if (/image|screenshot/i.test(name)) return Images;
  if (/search|browse|web|fetch/i.test(name)) return Globe;
  if (/read|open_file/i.test(name)) return BookOpen;
  if (/bash|powershell|shell|exec|terminal/i.test(name)) return SquareTerminal;
  if (/write|edit|patch/i.test(name)) return FilePenLine;
  if (/grep|find/i.test(name)) return ListFilter;
  if (/^(ls|list_directory)$/.test(name)) return FolderOpen;
  if (/sql|database/i.test(name)) return Database;
  if (/git/i.test(name)) return GitBranch;
  return Wrench;
}
