import { useState } from "react";
import { FolderSearch, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "@/components/ui/toast";
import { useAppTranslation } from "@/i18n";
import {
  settingsErrorDescription,
  settingsFailure,
} from "../settings-notification";
import type { SkillInfo } from "../../../../../shared/contracts";

const mac = navigator.platform.startsWith("Mac");
// One look for a skill call, in the draft and in the sent message: neutral,
// so it reads on the plain composer and on the tinted message alike. Each
// adds its own fill: white over the message's tint, a light grey on white.
// No taller than a line, so wrapped text below keeps its spacing.
const chip =
  "h-6 gap-1 rounded-md border border-black/10 ps-[5px] pe-[7px] text-sm dark:border-white/15";

/** The skill a draft calls, drawn over its command text. */
export function SkillCommandChip({ name }: { name: string }) {
  return (
    <span
      data-slot="skill-command-chip"
      className={`inline-flex max-w-full min-w-0 items-center bg-black/[0.02] text-foreground dark:bg-white/10 ${chip}`}
    >
      <ScrollText className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Marks the skill a sent message calls; opens what the skill does. */
export function SkillCommandTag({ name }: { name: string }) {
  const { t, language } = useAppTranslation();
  const [skill, setSkill] = useState<SkillInfo | null>();
  const [error, setError] = useState<string>();

  function load() {
    setSkill(undefined);
    setError(undefined);
    void window.worklens.invoke("skillsList", undefined).then(
      (snapshot) =>
        setSkill(
          [...snapshot.builtin, ...snapshot.local].find(
            (item) => item.name === name && !item.shadowedBy,
          ) ?? null,
        ),
      (reason) => setError(String(reason)),
    );
  }

  async function reveal(skill: SkillInfo) {
    try {
      await window.worklens.invoke("skillsReveal", { id: skill.id });
    } catch (e) {
      toast.add(settingsFailure(t("skills.revealFailed"), String(e), language));
    }
  }

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) load();
      }}
    >
      <PopoverTrigger
        data-slot="skill-command-tag"
        data-searchable
        aria-label={t("skills.viewDetails", { skill: name })}
        className={`me-0.5 inline-flex max-w-full cursor-pointer items-center outline-none bg-white/70 hover:bg-white dark:bg-white/10 focus-visible:ring-2 focus-visible:ring-ring/50 dark:hover:bg-white/15 ${chip}`}
      >
        <ScrollText
          className="size-3.5 shrink-0 opacity-60"
          aria-hidden="true"
        />
        {/* The name, not the icon, sets the baseline that meets the text. */}
        <span className="min-w-0 self-baseline truncate">{name}</span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-80 flex-col gap-2 p-3 whitespace-normal"
        aria-label={t("skills.viewDetails", { skill: name })}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <ScrollText className="size-4" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
          {skill && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {t(
                skill.source === "builtin"
                  ? "skills.builtinSkill"
                  : "skills.localSkill",
              )}
            </span>
          )}
        </div>
        {error ? (
          <p role="alert" className="text-muted-foreground">
            {settingsErrorDescription(error, language)}
          </p>
        ) : skill === undefined ? (
          <p role="status" className="text-muted-foreground">
            {t("skills.loading")}
          </p>
        ) : (
          <>
            {skill && (
              <p className="max-h-48 overflow-y-auto text-[13px] leading-5 wrap-break-word whitespace-pre-wrap text-muted-foreground">
                {skill.description}
              </p>
            )}
            {!skill?.enabled && (
              <p className="text-[13px] leading-5 text-muted-foreground">
                {t("skills.unavailable")}
              </p>
            )}
            {skill && (
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => void reveal(skill)}
              >
                <FolderSearch data-icon="inline-start" />
                {t(
                  mac
                    ? "skills.showSkillFileInFinder"
                    : "skills.showSkillFileInFolder",
                )}
              </Button>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
