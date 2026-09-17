import { useCallback, useEffect, useRef, useState } from "react";
import { FileSearchCorner, Info, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "@/components/ui/item";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { useAppTranslation } from "@/i18n";
import { SearchInput } from "../SearchInput";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  settingsErrorDescription,
  settingsFailure,
} from "../settings-notification";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import type {
  SkillInfo,
  SkillsSnapshot,
} from "../../../../../shared/contracts";

const api = window.worklens;
const mac = navigator.platform.startsWith("Mac");

export function SkillsSettings({
  onSuccess,
}: {
  onSuccess: (message: string) => void;
}) {
  const { t, language } = useAppTranslation();
  const [snapshot, setSnapshot] = useState<SkillsSnapshot>();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const [loadError, setLoadError] = useState<string>();
  const [selected, setSelected] = useState<SkillInfo>();
  const load = useCallback(
    async (rescan = false) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setLoadError(undefined);
      try {
        setSnapshot(
          await api.invoke(rescan ? "skillsRefresh" : "skillsList", undefined),
        );
        if (rescan) onSuccessRef.current(t("skills.skillsRefreshed"));
      } catch (e) {
        setLoadError(settingsErrorDescription(String(e), language));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [t, language],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function toggle(skill: SkillInfo, enabled: boolean) {
    if (busyRef.current || skill.shadowedBy) return;
    busyRef.current = true;
    setBusy(true);
    try {
      setSnapshot(await api.invoke("skillsToggle", { id: skill.id, enabled }));
      onSuccess(
        t(enabled ? "skills.skillEnabled" : "skills.skillDisabled", {
          skill: skill.name,
        }),
      );
    } catch (e) {
      toast.add(settingsFailure(t("skills.toggleFailed"), String(e), language));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function reveal(skill: SkillInfo) {
    try {
      await api.invoke("skillsReveal", { id: skill.id });
    } catch (e) {
      toast.add(settingsFailure(t("skills.revealFailed"), String(e), language));
    }
  }
  const search = query.trim().toLocaleLowerCase();
  const matches = (skill: SkillInfo) =>
    `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(search);
  const groups = (
    [
      {
        id: "builtin",
        label: t("skills.builtin"),
        description: t("skills.builtinDescription"),
        items: snapshot?.builtin ?? [],
        emptyLabel: t("skills.noBuiltinSkills"),
      },
      {
        id: "local",
        label: t("skills.localHeading"),
        description: t("skills.localDescription"),
        items: snapshot?.local ?? [],
        emptyLabel: t("skills.noLocalSkills"),
      },
    ] as const
  )
    .filter((group) => scope === "all" || scope === group.id)
    .map((group) => ({
      ...group,
      items: search ? group.items.filter(matches) : group.items,
    }))
    // A search filters empty groups out entirely; with no search, an
    // empty group is still shown with its own empty state.
    .filter((group) => !search || group.items.length);
  return (
    <>
      <div className="settings-toolbar">
        <SearchInput
          aria-label={t("skills.searchSkills")}
          placeholder={t("skills.searchSkillsPlaceholder")}
          value={query}
          onValueChange={setQuery}
        />
        <NativeSelect
          aria-label={t("skills.filterSkills")}
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        >
          <NativeSelectOption value="all">
            {t("skills.allSkills")}
          </NativeSelectOption>
          <NativeSelectOption value="builtin">
            {t("skills.builtin")}
          </NativeSelectOption>
          <NativeSelectOption value="local">
            {t("skills.local")}
          </NativeSelectOption>
        </NativeSelect>
        <TooltipIconButton
          variant="ghost"
          className="size-[38px] p-0"
          size="icon"
          aria-label={t("skills.refreshSkills")}
          tooltip={t("skills.refreshSkills")}
          disabled={busy}
          onClick={() => void load(true)}
        >
          <RefreshCw className={busy ? "spin" : undefined} />
        </TooltipIconButton>
      </div>
      {loadError && (
        <div role="alert" className="settings-list p-4">
          <p className="text-sm">
            {t("skills.loadFailed")}: {loadError}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            disabled={busy}
            onClick={() => void load(true)}
          >
            {t("skills.retry")}
          </Button>
        </div>
      )}
      {!snapshot && !loadError && (
        <p role="status" className="settings-empty">
          {t("skills.loading")}
        </p>
      )}
      {snapshot &&
        groups.map((group) => (
          <section className="settings-section" key={group.id}>
            <h2
              data-slot="settings-section-title"
              className="settings-section-heading settings-group-bar"
            >
              {group.label}
              <span className="settings-group-count" aria-hidden="true">
                {group.items.length}
              </span>
              <Hint content={group.description}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="size-5"
                  aria-label={t("skills.about", { group: group.label })}
                >
                  <Info aria-hidden="true" />
                </Button>
              </Hint>
            </h2>
            {group.items.length ? (
              <ItemGroup className="settings-list settings-skill-list">
                {group.items.map((skill) => (
                  <Item
                    size="sm"
                    role="listitem"
                    className="settings-entry"
                    key={skill.id}
                  >
                    <ItemContent className="settings-entry-copy">
                      <ItemTitle className="settings-entry-title">
                        <Button
                          variant="link"
                          className="h-auto min-w-0 justify-start p-0 text-left text-inherit"
                          aria-label={t("skills.viewDetails", {
                            skill: skill.name,
                          })}
                          onClick={() => setSelected(skill)}
                        >
                          <span className="truncate">{skill.name}</span>
                        </Button>
                      </ItemTitle>
                      <ItemDescription className="settings-entry-description truncate">
                        {skill.shadowedBy
                          ? t("skills.shadowed", {
                              source: t(
                                skill.shadowedBy === "builtin"
                                  ? "skills.builtin"
                                  : "skills.local",
                              ),
                            })
                          : skill.summary}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions className="settings-entry-actions">
                      <Hint
                        content={
                          mac
                            ? t("skills.showSkillFileInFinder")
                            : t("skills.showSkillFileInFolder")
                        }
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("skills.showSkillFile", {
                            skill: skill.name,
                          })}
                          onClick={() => void reveal(skill)}
                        >
                          <FileSearchCorner strokeWidth={1.75} />
                        </Button>
                      </Hint>
                      <Hint
                        content={t(
                          skill.enabled
                            ? "skills.disableSkill"
                            : "skills.enableSkill",
                        )}
                      >
                        <Switch
                          size="sm"
                          aria-label={t("skills.toggleSkill", {
                            skill: skill.name,
                          })}
                          checked={skill.enabled}
                          disabled={busy || !!skill.shadowedBy}
                          onCheckedChange={(checked) =>
                            void toggle(skill, checked)
                          }
                        />
                      </Hint>
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            ) : (
              <div className="settings-list">
                <p className="settings-empty">{group.emptyLabel}</p>
              </div>
            )}
          </section>
        ))}
      {snapshot && !groups.length && (
        <p className="settings-empty">{t("skills.noSkillsMatchYourFilters")}</p>
      )}
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
      >
        {selected && (
          <DialogContent className="settings-dialog">
            <DialogHeader>
              <DialogTitle>{selected.name}</DialogTitle>
            </DialogHeader>
            <DialogDescription className="whitespace-pre-wrap break-words">
              {selected.description}
            </DialogDescription>
            {selected.shadowedBy && (
              <p className="text-sm text-muted-foreground">
                {t("skills.shadowed", {
                  source: t(
                    selected.shadowedBy === "builtin"
                      ? "skills.builtin"
                      : "skills.local",
                  ),
                })}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {t(
                selected.disableModelInvocation
                  ? "skills.manualOnly"
                  : "skills.autoAndManual",
              )}{" "}
              <code>/skill:{selected.name}</code>
            </p>
            <p className="text-sm text-muted-foreground">
              {t("skills.appliesNextTurn")}
            </p>
            <Button variant="outline" onClick={() => void reveal(selected)}>
              {t(
                mac
                  ? "skills.showSkillFileInFinder"
                  : "skills.showSkillFileInFolder",
              )}
            </Button>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
