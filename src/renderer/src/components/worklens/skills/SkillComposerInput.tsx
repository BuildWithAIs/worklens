import { useEffect, useId, useRef, useState } from "react";
import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { Sparkles } from "lucide-react";
import { useAppTranslation } from "@/i18n";
import { settingsErrorDescription } from "../settings-notification";
import type { SkillInfo } from "../../../../../shared/contracts";

/** Completes Pi's native command without submitting the user's draft. */
export function SkillComposerInput({ autoFocus }: { autoFocus: boolean }) {
  const { t, language } = useAppTranslation();
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const running = useAuiState((s) => s.thread.isRunning);
  const input = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [active, setActive] = useState(0);
  const match = /^\/(?:skill:)?([^\s]*)$/.exec(text);
  const open = focused && !!match && !dismissed && !running;
  const query = match?.[1].toLocaleLowerCase() ?? "";
  const items = skills.filter((skill) =>
    `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query),
  );
  const index = Math.min(active, Math.max(0, items.length - 1));

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

  function select(skill: SkillInfo) {
    aui.composer.setText(`/skill:${skill.name} `);
    input.current?.focus();
  }

  return (
    <>
      {open && (
        <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg">
          <p className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
            <Sparkles className="size-3.5 shrink-0" aria-hidden="true" />
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
    </>
  );
}
