import { shortTitle } from "@/lib/conversation-title";

export function HistoryTitle({ title }: { title: string }) {
  const label = shortTitle(title);
  return <span className="history-title-clip truncate" data-truncated={label !== title}>
    <span className="history-title-text">{label}</span>
  </span>;
}
