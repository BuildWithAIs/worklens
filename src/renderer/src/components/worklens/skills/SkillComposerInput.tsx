import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { ScrollText } from "lucide-react";
import { useAppTranslation } from "@/i18n";
import { settingsErrorDescription } from "../settings-notification";
import type { SkillInfo } from "../../../../../shared/contracts";
import { parseSkillCommand } from "../../../../../shared/skill-command";
import { SkillCommandChip } from "./SkillCommandTag";

/** Completes Pi's native command without submitting the user's draft. */
export function SkillComposerInput({ autoFocus }: { autoFocus: boolean }) {
  const { t, language } = useAppTranslation();
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const running = useAuiState((s) => s.thread.isRunning);
  const input = useRef<HTMLTextAreaElement>(null);
  const highlight = useRef<HTMLSpanElement>(null);
  const listId = useId();
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [active, setActive] = useState(0);
  const [fits, setFits] = useState(true);
  const match = /^\/(?:skill:)?([^\s]*)$/.exec(text);
  const open = focused && !!match && !dismissed && !running;
  const query = match?.[1].toLocaleLowerCase() ?? "";
  const items = skills.filter((skill) =>
    `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query),
  );
  const index = Math.min(active, Math.max(0, items.length - 1));
  // Marks a completed command; the chooser stays open while the name is typed.
  const command = /^\/skill:\S+(?=\s)/.test(text)
    ? parseSkillCommand(text)
    : undefined;

  useEffect(() => {
    setDismissed(false);
    setActive(0);
  }, [text]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSkills([]);
    setLoading(true);
    setError(undefined);
    void window.worklens
      .invoke("skillsList", undefined)
      .then(
        (snapshot) => {
          if (!cancelled)
            setSkills(
              [...snapshot.builtin, ...snapshot.local].filter(
                (skill) => skill.enabled,
              ),
            );
        },
        (reason) => {
          if (!cancelled) setError(String(reason));
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  useEffect(() => {
    if (open)
      document
        .getElementById(`${listId}-${index}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, listId, index, items.length]);

  useEffect(() => {
    if (command && input.current) syncHighlight(input.current);
  }, [command?.name]);
  // A command longer than a line wraps in the draft, where a chip can't cover
  // it; it then shows as typed.
  useLayoutEffect(() => {
    const textarea = input.current;
    const token = highlight.current;
    if (!textarea || !token) return;
    const measure = () => {
      const style = getComputedStyle(textarea);
      setFits(
        token.offsetWidth <=
          textarea.clientWidth -
            parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [command?.name]);

  // The chip sits over the text, which scrolls with a long draft.
  function syncHighlight(textarea: HTMLTextAreaElement) {
    if (highlight.current)
      highlight.current.style.transform = `translateY(${-textarea.scrollTop}px)`;
  }

  function select(skill: SkillInfo) {
    aui.composer.setText(`/skill:${skill.name} `);
    input.current?.focus();
  }

  return (
    <>
      {open && (
        <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg">
          <p className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
            <ScrollText className="size-3.5 shrink-0" aria-hidden="true" />
            {t("skills.chooseSkill")}
          </p>
          {loading ? (
            <p role="status" className="px-3 py-2 text-sm">
              {t("skills.loading")}
            </p>
          ) : error ? (
            <p role="alert" className="px-3 py-2 text-sm">
              {settingsErrorDescription(error, language)}
            </p>
          ) : (
            <div
              id={listId}
              role="listbox"
              aria-label={t("skills.chooseSkill")}
              className="max-h-64 overflow-y-auto"
            >
              {items.map((skill, i) => (
                <button
                  key={skill.id}
                  id={`${listId}-${i}`}
                  type="button"
                  data-slot="skill-command-option"
                  role="option"
                  aria-selected={i === index}
                  tabIndex={-1}
                  className={`flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-sm px-3 py-1.5 text-left text-sm ${i === index ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => select(skill)}
                >
                  <span className="w-full truncate font-medium">
                    {skill.name}
                  </span>
                  <span className="w-full truncate text-xs text-muted-foreground">
                    {skill.summary}
                  </span>
                </button>
              ))}
              {!items.length && (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  {t("skills.noEnabledSkillsMatch")}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      <div className="relative">
        <ComposerPrimitive.Input
          ref={input}
          placeholder={t("skills.messagePlaceholder")}
          className="aui-composer-input caret-primary placeholder:text-muted-foreground/60 max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-sm leading-6 outline-none"
          rows={1}
          autoFocus={autoFocus}
          enterKeyHint="send"
          aria-label={t("thread.message")}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open && !loading && !error ? listId : undefined}
          aria-activedescendant={
            open && items.length ? `${listId}-${index}` : undefined
          }
          cancelOnEscape={!open}
          onFocus={() => {
            setFocused(true);
            setDismissed(false);
          }}
          onBlur={() => setFocused(false)}
          onScroll={(event) => syncHighlight(event.currentTarget)}
          onSelect={(event) => {
            // The chip is one piece: a caret placed in or before its command
            // moves past it, so typing can't change the skill by accident.
            const textarea = event.currentTarget;
            const end = command ? `/skill:${command.name}`.length : -1;
            if (
              !command ||
              !fits ||
              textarea.selectionStart !== textarea.selectionEnd ||
              textarea.selectionStart > end
            )
              return;
            textarea.setSelectionRange(end + 1, end + 1);
          }}
          onKeyDown={(event) => {
            if (!open || event.nativeEvent.isComposing || event.keyCode === 229)
              return;
            if (event.key === "Escape") {
              event.preventDefault();
              setDismissed(true);
            } else if (
              items.length &&
              ["ArrowDown", "ArrowUp"].includes(event.key)
            ) {
              event.preventDefault();
              setActive(
                (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
                  items.length,
              );
            } else if (
              !event.shiftKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              ["Enter", "Tab"].includes(event.key) &&
              (items.length || loading)
            ) {
              event.preventDefault();
              if (items[index]) select(items[index]);
            }
          }}
        />
        {command && (
          // Covers the command text with the chip; the text stays in the
          // draft, so sending, drafts and IME input are unchanged.
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 overflow-hidden px-2.5 py-1 text-sm leading-6 wrap-break-word whitespace-pre-wrap text-transparent"
          >
            <span
              ref={highlight}
              data-slot="skill-command-highlight"
              className="relative inline-block whitespace-nowrap"
            >
              /skill:{command.name}
              {fits && (
                <span className="absolute inset-y-0 -start-px -end-px flex items-center bg-(--composer-bg)">
                  <SkillCommandChip name={command.name} />
                </span>
              )}
            </span>
          </div>
        )}
      </div>
    </>
  );
}
