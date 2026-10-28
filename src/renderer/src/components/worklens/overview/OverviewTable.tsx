import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { SearchInput } from "../SearchInput";
import { languageTag, useAppTranslation } from "@/i18n";
import { formatTokens } from "@/lib/usage-format";
import { formatAgo, formatLastActive } from "@/lib/overview-format";
import { ProviderIcon } from "../ProviderIcon";
import { nonNegative } from "../../../../../shared/usage";
import type {
  Overview,
  OverviewConversation,
  TokenUsage,
} from "../../../../../shared/contracts";
import type { TopicGroup } from "./OverviewCharts";

/** What the conversation panel lists: everything, or one selection above. */
export type TableFilter =
  | { kind: "all"; label: string }
  | { kind: "topic"; topicId: string; label: string }
  | { kind: "day"; day: string; label: string }
  | { kind: "model"; provider: string; model: string; label: string }
  | { kind: "ids"; id: string; ids: ReadonlySet<string>; label: string };

function matches(item: OverviewConversation, filter: TableFilter) {
  switch (filter.kind) {
    case "all":
      return true;
    case "topic":
      return item.topicId === filter.topicId;
    case "day":
      return item.days.includes(filter.day);
    case "model":
      return item.models.some(
        (used) =>
          used.provider === filter.provider && used.model === filter.model,
      );
    case "ids":
      return filter.ids.has(item.id);
  }
}

/** Search and sorting appear once a list is too long to scan. */
const SEARCH_FROM = 11;
/** Rows rendered at first and added each time the list nears its end. */
const PAGE = 50;

/** Known tokens; "≥" marks a total that misses some requests. */
export function TokenCount({ usage }: { usage: TokenUsage }) {
  const { t } = useAppTranslation();
  if (!nonNegative(usage.total))
    return <span className="overview-muted">—</span>;
  if (usage.status === "complete") return <>{formatTokens(usage.total)}</>;
  return (
    <Hint content={t("overview.partialHint")}>
      <span className="overview-partial" tabIndex={0}>
        ≥{formatTokens(usage.total)}
      </span>
    </Hint>
  );
}

/**
 * A panel over the report's right edge listing the conversations behind a
 * selection, most tokens or most recent first. A row opens the conversation.
 */
export function ConversationDrawer({
  overview,
  filter,
  onClose,
  onOpen,
  conversationTitle,
  modelName,
  groups,
}: {
  overview: Overview;
  filter: TableFilter;
  onClose: () => void;
  onOpen: (id: string) => void;
  conversationTitle: (conversation: OverviewConversation) => string;
  modelName: (provider?: string, model?: string) => string;
  /** The focus areas shown in the report; each row shows its own. */
  groups: TopicGroup[];
}) {
  const { t, language } = useAppTranslation();
  const locale = languageTag(language);
  const panel = useRef<HTMLElement>(null);
  // Modal while open: focus moves in, Tab stays inside, and closing returns
  // focus to whatever opened the panel.
  useEffect(() => {
    const opener = document.activeElement;
    panel.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  // On the panel rather than the window: a tooltip left open on the opener
  // takes a window-level Escape first, and the search field can still claim
  // the first Escape to clear itself.
  const keydown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") onClose();
    if (event.key !== "Tab" || !panel.current) return;
    const items = Array.from(
      panel.current.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), [tabindex='0']",
      ),
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (
      event.shiftKey
        ? active === first || active === panel.current
        : active === last
    ) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"tokens" | "recent">("tokens");
  const [limit, setLimit] = useState(PAGE);
  const list = useRef<HTMLOListElement>(null);
  const groupOf = new Map<string, TopicGroup>();
  for (const group of groups)
    for (const id of group.conversationIds) groupOf.set(id, group);
  const all = overview.conversations.filter((item) => matches(item, filter));
  const searchable = all.length >= SEARCH_FROM;
  const words = searchable
    ? query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    : [];
  const names = (item: OverviewConversation) =>
    item.models.map((used) => modelName(used.provider, used.model));
  const rows = all.filter((item) => {
    if (!words.length) return true;
    const text = [
      conversationTitle(item),
      groupOf.get(item.id)?.label ?? "",
      ...names(item),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
  // Conversations arrive with the most tokens first.
  if (searchable && sort === "recent")
    rows.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  const byGroup = filter.kind === "topic" || filter.kind === "ids";
  const maxTokens = Math.max(1, ...rows.map((item) => item.usage.total ?? 0));
  const now = new Date();
  const reset = () => {
    setLimit(PAGE);
    list.current?.scrollTo({ top: 0 });
  };
  return (
    <>
      <div className="overview-drawer-backdrop" onClick={onClose} />
      <aside
        ref={panel}
        className="overview-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={filter.label}
        tabIndex={-1}
        onKeyDown={keydown}
      >
        <header className="overview-drawer-head">
          <div className="overview-drawer-title">
            <h2 data-slot="overview-heading" className="truncate">
              {filter.label}
            </h2>
            <span>
              {words.length
                ? t("overview.list.matches", {
                    count: rows.length,
                    total: all.length,
                  })
                : t(
                    // The sort control names the order once it is shown.
                    searchable
                      ? "overview.list.countAll"
                      : "overview.list.count",
                    { count: all.length },
                  )}
            </span>
          </div>
          <button
            data-slot="overview-button"
            type="button"
            className="overview-icon-button"
            aria-label={t("overview.list.close")}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        {searchable && (
          <div className="overview-drawer-tools">
            <SearchInput
              aria-label={t("overview.list.search")}
              placeholder={t("overview.list.search")}
              value={query}
              onValueChange={(next) => {
                setQuery(next);
                reset();
              }}
              onKeyDown={(event) => {
                // The first Escape clears the search; the next closes the panel.
                if (event.key === "Escape" && query) {
                  event.stopPropagation();
                  setQuery("");
                  reset();
                }
              }}
            />
            <span
              className="overview-toggle"
              role="group"
              aria-label={t("overview.list.sort")}
            >
              {(["tokens", "recent"] as const).map((key) => (
                <button
                  key={key}
                  data-slot="overview-button"
                  type="button"
                  aria-pressed={sort === key}
                  onClick={() => {
                    setSort(key);
                    reset();
                  }}
                >
                  {t(`overview.list.sorts.${key}`)}
                </button>
              ))}
            </span>
          </div>
        )}
        {rows.length ? (
          <ol
            ref={list}
            className="overview-drawer-list"
            onScroll={(event) => {
              const el = event.currentTarget;
              if (
                limit < rows.length &&
                el.scrollTop + el.clientHeight > el.scrollHeight - 200
              )
                setLimit(limit + PAGE);
            }}
          >
            {rows.slice(0, limit).map((item) => {
              // The meta line skips what the panel's selection already says.
              const group = byGroup ? undefined : groupOf.get(item.id);
              const used = filter.kind === "model" ? [] : names(item);
              return (
                <li key={item.id}>
                  <button
                    data-slot="overview-button"
                    type="button"
                    className="overview-drawer-row"
                    onClick={() => onOpen(item.id)}
                  >
                    <span className="overview-drawer-main">
                      <span className="overview-drawer-name">
                        {conversationTitle(item)}
                      </span>
                      <span className="overview-drawer-meta">
                        {group && (
                          <span className="overview-list-group">
                            <group.Icon aria-hidden="true" />
                            <span className="truncate">{group.label}</span>
                          </span>
                        )}
                        {used.length > 0 && (
                          <Hint content={used.join(", ")}>
                            <span
                              className="overview-drawer-models"
                              role="img"
                              aria-label={used.join(", ")}
                            >
                              {[
                                ...new Set(
                                  item.models.map((model) => model.provider),
                                ),
                              ].map((provider) => (
                                <ProviderIcon
                                  key={provider ?? ""}
                                  provider={provider}
                                />
                              ))}
                            </span>
                          </Hint>
                        )}
                        <Hint
                          content={formatLastActive(item.lastAt, now, locale)}
                        >
                          <span>{formatAgo(item.lastAt, now, locale)}</span>
                        </Hint>
                      </span>
                    </span>
                    <span className="overview-list-tokens">
                      <TokenCount usage={item.usage} />
                      <span className="overview-mini" aria-hidden="true">
                        <i
                          style={{
                            width: `${((item.usage.total ?? 0) / maxTokens) * 100}%`,
                          }}
                        />
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        ) : words.length ? (
          <div className="overview-drawer-empty">
            {t("overview.list.noSearchMatches")}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery("");
                reset();
              }}
            >
              {t("search.clearSearch")}
            </Button>
          </div>
        ) : (
          <div className="overview-empty-text">
            {t("overview.list.noMatches")}
          </div>
        )}
      </aside>
    </>
  );
}
