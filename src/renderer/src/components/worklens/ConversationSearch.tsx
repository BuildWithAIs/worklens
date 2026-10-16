import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MessageCircle, Search, X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
// While loading, the result area is at least this many rows tall.
const LOADING_ROWS = 4;
// Placeholder rows drawn: enough to fill the tallest result area, which
// clips the rest.
const SKELETON_ROWS = 9;

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
    requestId: number;
    items: ConversationSearchResult[];
  }>();
  const [failed, setFailed] = useState<number>();
  const [active, setActive] = useState(0);
  const trimmed = query.trim();
  // A reopening or a return to an earlier query is a new request too.
  const [request, setRequest] = useState({ open, query: trimmed, id: 0 });
  if (request.open !== open || request.query !== trimmed)
    setRequest({ open, query: trimmed, id: request.id + 1 });

  useEffect(() => {
    if (!open) return;
    // Index conversations while the query is typed; a search takes over.
    api.invoke("prepareSearch", {}).catch(() => {});
    // Closing stops the warm-up and any search; finished indexing stays.
    return () =>
      void api.invoke("cancelSearch", { warmUp: true }).catch(() => {});
  }, [open]);
  useEffect(() => {
    if (!open || !trimmed) return;
    let cancelled = false;
    let inFlight = false;
    const timer = setTimeout(() => {
      inFlight = true;
      api
        .invoke("searchConversations", { query: trimmed })
        .then((items) => {
          if (cancelled) return;
          setFailed(undefined);
          setResults({ query: trimmed, requestId: request.id, items });
        })
        .catch(() => {
          if (!cancelled) setFailed(request.id);
        })
        .finally(() => (inFlight = false));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      // Nobody waits for this search once the query changes or is cleared.
      if (inFlight)
        api.invoke("cancelSearch", { warmUp: false }).catch(() => {});
    };
  }, [open, trimmed, request.id]);

  const searching = !!trimmed;
  const items: (ConversationSearchResult & { query?: string })[] = searching
    ? (results?.items ?? []).map((item) => ({ ...item, query: results?.query }))
    : recents.slice(0, RECENT_LIMIT);
  // Results of an earlier query can't be chosen.
  const stale = searching && results?.requestId !== request.id;
  const pending = stale && failed !== request.id;
  // As in Claude, placeholders show as soon as the query changes and stay
  // until its results arrive.
  const skeleton = pending;
  const loading = useRef(false);
  loading.current = skeleton;

  // The result area eases to its content's height, up to the room the
  // dialog has. While loading it only grows: to at least LOADING_ROWS
  // placeholder rows, or keeping a taller height, so it shrinks only when
  // results arrive.
  const fitting = useRef<() => void>(undefined);
  const refit = useRef<() => void>(undefined);
  const resultArea = useRef<HTMLElement>(undefined);
  const fitResults = useCallback((content: HTMLDivElement | null) => {
    fitting.current?.();
    fitting.current = refit.current = resultArea.current = undefined;
    const area = content?.parentElement;
    const dialog = area?.closest<HTMLElement>('[data-slot="dialog-content"]');
    if (!content || !area || !dialog) return;
    resultArea.current = area;
    const fit = () => {
      const padding = getComputedStyle(area);
      const paddings =
        parseFloat(padding.paddingTop) + parseFloat(padding.paddingBottom);
      // Exact heights: a rounded-down one leaves a sliver to scroll.
      const natural = Math.ceil(
        content.getBoundingClientRect().height + paddings,
      );
      const room = Math.floor(
        parseFloat(getComputedStyle(dialog).maxHeight) -
          (dialog.getBoundingClientRect().height -
            area.getBoundingClientRect().height),
      );
      let target = natural;
      if (loading.current) {
        const row = content.querySelector(".conversation-search-option");
        const rows = Math.ceil(
          (row?.getBoundingClientRect().height ?? 0) * LOADING_ROWS + paddings,
        );
        target = Math.max(parseFloat(area.style.height) || 0, rows);
      }
      area.style.height = `${Math.min(target, room)}px`;
      // Scroll only when results outgrow the dialog, so no scrollbar shows
      // while the height eases or placeholders fill it.
      area.style.overflowY =
        !loading.current && natural > room ? "auto" : "hidden";
    };
    fit();
    refit.current = fit;
    // Only after the first fit, so the dialog doesn't grow as it opens.
    const frame = requestAnimationFrame(() => (area.dataset.animate = "true"));
    const observer = new ResizeObserver(fit);
    observer.observe(content);
    window.addEventListener("resize", fit);
    fitting.current = () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);
  useLayoutEffect(() => refit.current?.(), [skeleton]);
  // New content starts at the top: placeholders, a new query's results and
  // the recents. Moving the selection scrolls on its own.
  const shown = skeleton ? "loading" : searching ? results?.query : "recents";
  useLayoutEffect(() => {
    if (resultArea.current) resultArea.current.scrollTop = 0;
  }, [shown, results]);
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
  if (searching && failed === request.id) status = t("search.couldntSearch");
  else if (searching && !stale && !items.length)
    status = t("search.noConversationsMatch");
  else if (!searching && !items.length) status = t("app.noConversationsYet");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="conversation-search gap-0 overflow-hidden rounded-[14px] p-0"
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
            <span role="status" className="sr-only">
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
        <div className="conversation-search-results min-h-0 overflow-x-hidden overflow-y-auto px-1.5 py-2.5">
          <div ref={fitResults}>
            {!searching && items.length > 0 && (
              <div className="px-3 pt-2 pb-1 text-xs text-muted-foreground">
                {t("app.recents")}
              </div>
            )}
            <div>
              {skeleton && (
                <div aria-hidden="true" data-slot="search-skeleton">
                  {Array.from({ length: SKELETON_ROWS }, (_, row) => row).map(
                    (row) => (
                      // Sized like a result row: a title line and a snippet line.
                      <div key={row} className="conversation-search-option">
                        <Skeleton className="mt-0.5 size-4 shrink-0 rounded-full" />
                        <div className="min-w-0 flex-1">
                          <div className="flex h-5 items-center">
                            <Skeleton className="h-3.5 w-2/5" />
                          </div>
                          <div className="mt-0.5 flex h-4 items-center">
                            <Skeleton className="h-3 w-4/5" />
                          </div>
                        </div>
                        <div className="flex h-5 shrink-0 items-center">
                          <Skeleton className="h-3 w-12" />
                        </div>
                      </div>
                    ),
                  )}
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
                hidden={skeleton}
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
