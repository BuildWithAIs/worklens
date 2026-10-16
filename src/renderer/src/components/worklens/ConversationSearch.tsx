import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { MessageCircle, Search, X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { languageTag, useAppTranslation, type AppLanguage } from "@/i18n";
import {
  findSearchMatch,
  foldSearchText,
} from "../../../../shared/search-text";
import type {
  Conversation,
  ConversationSearchResult,
} from "../../../../shared/contracts";

const api = window.worklens;
const RECENT_LIMIT = 8;

export type SearchSelection = {
  id: string;
  /** Present when the conversation was found by a query, to reveal the match. */
  query?: string;
  messageId?: string;
};

function Highlighted({ text, query }: { text: string; query: string }) {
  const needle = foldSearchText(query.trim());
  const index = findSearchMatch(text, needle);
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + needle.length)}</mark>
      {text.slice(index + needle.length)}
    </>
  );
}

function updatedLabel(
  value: string,
  language: AppLanguage,
  t: ReturnType<typeof useAppTranslation>["t"],
) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const days = Math.round(
    (new Date(today.toDateString()).getTime() -
      new Date(date.toDateString()).getTime()) /
      86_400_000,
  );
  if (days === 0) return t("search.today");
  if (days === 1) return t("search.yesterday");
  return new Intl.DateTimeFormat(languageTag(language), {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== today.getFullYear()
      ? { year: "numeric" as const }
      : {}),
  }).format(date);
}

export function ConversationSearch({
  open,
  onOpenChange,
  recents,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recents: readonly Conversation[];
  onSelect: (selection: SearchSelection) => void;
}) {
  const { t, language } = useAppTranslation();
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{
    query: string;
    items: ConversationSearchResult[];
  }>();
  /** The query whose search failed. */
  const [failed, setFailed] = useState<string>();
  const [active, setActive] = useState(0);
  const trimmed = query.trim();

  useEffect(() => {
    if (!open || !trimmed) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .invoke("searchConversations", { query: trimmed })
        .then((items) => {
          if (cancelled) return;
          setFailed(undefined);
          setResults({ query: trimmed, items });
        })
        .catch(() => {
          if (!cancelled) setFailed(trimmed);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, trimmed]);

  const searching = !!trimmed;
  const items: (ConversationSearchResult & { query?: string })[] = searching
    ? (results?.items ?? []).map((item) => ({ ...item, query: results?.query }))
    : recents.slice(0, RECENT_LIMIT);
  // Results of an earlier query stay visible but can't be chosen.
  const stale = searching && results?.query !== trimmed;
  const pending = stale && failed !== trimmed;
  const selected = Math.min(active, Math.max(0, items.length - 1));
  const optionId = (index: number) => `${listId}-option-${index}`;

  useEffect(() => setActive(0), [trimmed, results]);
  useEffect(() => {
    document
      .getElementById(optionId(selected))
      ?.scrollIntoView({ block: "nearest" });
  });

  const choose = (item: (typeof items)[number]) =>
    !stale &&
    onSelect({
      id: item.id,
      ...(item.query && item.snippet
        ? { query: item.query, messageId: item.messageId }
        : {}),
    });

  let status: ReactNode;
  if (searching && failed === trimmed) status = t("search.couldntSearch");
  else if (searching && !stale && !items.length)
    status = t("search.noConversationsMatch");
  else if (!searching && !items.length) status = t("app.noConversationsYet");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="conversation-search gap-0 overflow-hidden rounded-[14px] p-0 shadow-[0_24px_64px_-16px_rgb(0_0_0/0.28)] ring-foreground/8"
        overlayClassName="conversation-search-backdrop"
        showCloseButton={false}
        initialFocus={input}
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">
          {t("search.searchConversations")}
        </DialogTitle>
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Search
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <input
            ref={input}
            data-slot="conversation-search-input"
            role="combobox"
            aria-label={t("search.searchConversations")}
            aria-expanded={items.length > 0 && !stale}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              items.length && !stale ? optionId(selected) : undefined
            }
            placeholder={t("search.search")}
            className="min-w-0 flex-1 bg-transparent py-1 text-[15px] outline-none placeholder:text-muted-foreground"
            value={query}
            maxLength={200}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (!items.length || stale) return;
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActive((selected + step + items.length) % items.length);
              } else if (event.key === "Enter") {
                // Never open a result of the previous query.
                event.preventDefault();
                if (items[selected]) choose(items[selected]);
              }
            }}
          />
          {pending && (
            <span role="status" className="text-xs text-muted-foreground">
              {t("search.searching")}
            </span>
          )}
          {query && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setQuery("");
                input.current?.focus();
              }}
            >
              {t("search.clear")}
            </Button>
          )}
          <DialogClose
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("common.close")}
              />
            }
          >
            <X />
          </DialogClose>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pt-1.5 pb-4">
          {!searching && items.length > 0 && (
            <div className="px-3 pt-2 pb-1 text-xs text-muted-foreground">
              {t("app.recents")}
            </div>
          )}
          {status && (
            <p
              role="status"
              className="px-3 py-8 text-center text-sm text-muted-foreground"
            >
              {status}
            </p>
          )}
          <div
            id={listId}
            role="listbox"
            aria-label={searching ? t("search.results") : t("app.recents")}
            aria-busy={pending}
            aria-disabled={stale || undefined}
            className={stale ? "opacity-50" : undefined}
          >
            {items.map((item, index) => (
              <div
                key={item.id}
                id={optionId(index)}
                role="option"
                aria-selected={!stale && index === selected}
                className="conversation-search-option"
                onMouseMove={() => setActive(index)}
                onClick={() => choose(item)}
              >
                <MessageCircle
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate">
                    {item.query ? (
                      <Highlighted text={item.title} query={item.query} />
                    ) : (
                      item.title
                    )}
                  </div>
                  {item.snippet && (
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {item.snippet.before}
                      <mark>{item.snippet.match}</mark>
                      {item.snippet.after}
                    </div>
                  )}
                </div>
                <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
                  {updatedLabel(item.updatedAt, language, t)}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div
          aria-hidden="true"
          className="flex gap-5 border-t px-4 py-3.5 text-xs text-muted-foreground"
        >
          <span>
            {t("search.navigate")} <kbd>↑</kbd> <kbd>↓</kbd>
          </span>
          <span>
            {t("search.open")} <kbd>↵</kbd>
          </span>
          <span>
            {t("common.close")} <kbd>Esc</kbd>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
