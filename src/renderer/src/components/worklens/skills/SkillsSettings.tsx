import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
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
import { settingsFailure } from "../settings-notification";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import type {
  SkillInfo,
  SkillsSnapshot,
} from "../../../../../shared/contracts";

const api = window.worklens;

export function SkillsSettings({
  onSuccess,
}: {
  onSuccess: (message: string) => void;
}) {
  const { t, language } = useAppTranslation();
  const [snapshot, setSnapshot] = useState<SkillsSnapshot>();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const load = useCallback(async () => {
    try {
      setSnapshot(await api.invoke("skillsList", undefined));
    } catch (e) {
      toast.add(settingsFailure(t("skills.loadFailed"), String(e), language));
    }
  }, [t, language]);
  useEffect(() => {
    void load();
  }, [load]);
  async function refresh() {
    setRefreshing(true);
    try {
      setSnapshot(await api.invoke("skillsRefresh", undefined));
      onSuccess(t("skills.skillsRefreshed"));
    } catch (e) {
      toast.add(
        settingsFailure(t("skills.refreshFailed"), String(e), language),
      );
    } finally {
      setRefreshing(false);
    }
  }
  async function toggle(skill: SkillInfo, enabled: boolean) {
    if (pending.has(skill.name)) return;
    setPending((prev) => new Set(prev).add(skill.name));
    try {
      setSnapshot(
        await api.invoke("skillsToggle", { name: skill.name, enabled }),
      );
    } catch (e) {
      toast.add(settingsFailure(t("skills.toggleFailed"), String(e), language));
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(skill.name);
        return next;
      });
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
        id: "agents",
        label: t("skills.universal"),
        description: t("skills.universalDescription"),
        items: snapshot?.universal ?? [],
        emptyLabel: t("skills.noUniversalSkills"),
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
          <NativeSelectOption value="agents">
            {t("skills.universal")}
          </NativeSelectOption>
        </NativeSelect>
        <TooltipIconButton
          variant="ghost"
          className="size-[38px] p-0"
          size="icon"
          aria-label={t("skills.refreshSkills")}
          tooltip={t("skills.refreshSkills")}
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw className={refreshing ? "spin" : undefined} />
        </TooltipIconButton>
      </div>
      {groups.map((group) => (
        <section className="settings-section" key={group.id}>
          <h2 data-slot="settings-section-title" className="settings-group-bar">
            {group.label}
            <span className="settings-group-count" aria-hidden="true">
              {group.items.length}
            </span>
          </h2>
          <p className="settings-entry-description">{group.description}</p>
          {group.items.length ? (
            <ItemGroup className="settings-list">
              {group.items.map((skill) => (
                <Item
                  size="sm"
                  role="listitem"
                  className="settings-entry"
                  key={skill.name}
                >
                  <ItemContent className="settings-entry-copy">
                    <ItemTitle className="settings-entry-title">
                      {skill.name}
                    </ItemTitle>
                    <ItemDescription className="settings-entry-description">
                      {skill.description}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions className="settings-entry-actions">
                    <Switch
                      size="sm"
                      aria-label={t("skills.enableSkill", {
                        skill: skill.name,
                      })}
                      checked={skill.enabled}
                      disabled={pending.has(skill.name)}
                      onCheckedChange={(checked) => void toggle(skill, checked)}
                    />
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          ) : (
            <p className="settings-empty">{group.emptyLabel}</p>
          )}
        </section>
      ))}
      {!groups.length && (
        <p className="settings-empty">{t("skills.noSkillsMatchYourFilters")}</p>
      )}
    </>
  );
}
