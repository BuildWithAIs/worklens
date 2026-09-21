import {
  memo,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { Hint } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { languageTag, useAppTranslation } from "@/i18n";
import { SearchInput } from "./SearchInput";
import { ProviderIcon } from "./ProviderIcon";
import { settingsFailure } from "./settings-notification";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import type {
  Bootstrap,
  ProviderInfo,
  Settings,
} from "../../../../shared/contracts";

export function ModelManagementDialog({
  provider,
  settings,
  onClose,
  onSaved,
  onRefresh,
  onRefreshed,
}: {
  provider: ProviderInfo;
  settings: Settings;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onRefresh: () => Promise<Bootstrap>;
  onRefreshed: (added: number) => void;
}) {
  const { t, language } = useAppTranslation();
  const id = useId();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const disabled = busy || refreshing;
  const saving = useRef(false);
  // Only an explicit refresh updates this snapshot; background discovery must
  // not select or acknowledge models the user has not seen in this dialog.
  const [catalog, setCatalog] = useState(() => {
    const hidden = new Set(settings.hiddenModels ?? []);
    const fresh = new Set(settings.modelCatalogs?.[provider.id]?.new ?? []);
    const priority = (model: {
      selected: boolean;
      available: boolean;
      fresh: boolean;
    }) =>
      !model.selected && model.available
        ? model.fresh
          ? 0
          : 1
        : model.selected
          ? 2
          : 3;
    return provider.models
      .map((model) => ({
        ...model,
        selected: !hidden.has(`${provider.id}/${model.id}`),
        fresh: fresh.has(model.id),
      }))
      .sort((a, b) => priority(a) - priority(b));
  });
  const [selected, setSelected] = useState(
    () => new Set(catalog.filter((m) => m.selected).map((m) => m.id)),
  );
  const formatter = useMemo(
    () =>
      new Intl.NumberFormat(languageTag(language), {
        notation: "compact",
        maximumFractionDigits: 1,
      }),
    [language],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      catalog.filter((m) =>
        (m.name + " " + m.id).toLowerCase().includes(normalizedQuery),
      ),
    [catalog, normalizedQuery],
  );
  const matchedIds = useMemo(
    () => new Set(matches.map((m) => m.id)),
    [matches],
  );
  const toSelect = matches.filter((m) => m.available && !selected.has(m.id));
  const toClear = matches.filter((m) => selected.has(m.id));
  const toggle = useCallback((ids: string[], checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const id of ids) checked ? next.add(id) : next.delete(id);
      return next;
    });
  }, []);
  async function refreshCatalog() {
    if (saving.current) return;
    saving.current = true;
    setRefreshing(true);
    try {
      const next = await onRefresh();
      const updated = next.providers.find((item) => item.id === provider.id);
      if (!updated) throw new Error(t("settings.modelCatalogUnavailable"));
      const fresh = new Set(
        next.settings.modelCatalogs?.[provider.id]?.new ?? [],
      );
      const previousIds = new Set(catalog.map((model) => model.id));
      const incoming = new Map(
        updated.models.map((model) => [model.id, model]),
      );
      const added = updated.models
        .filter((model) => !previousIds.has(model.id))
        .map((model) => ({
          ...model,
          selected: false,
          fresh: fresh.has(model.id),
        }))
        .sort(
          (a, b) =>
            Number(b.available) - Number(a.available) ||
            Number(b.fresh) - Number(a.fresh),
        );
      // Keep all existing draft choices, even if a refreshed directory omits
      // a model temporarily. Missing entries remain visible as unavailable.
      setCatalog([
        ...added.filter((model) => model.available),
        ...catalog.map((model) => ({
          ...model,
          ...(incoming.get(model.id) ?? { available: false }),
          fresh: fresh.has(model.id),
        })),
        ...added.filter((model) => !model.available),
      ]);
      onRefreshed(added.length);
    } catch (error) {
      const failure = settingsFailure(
        t("settingsFeedback.refreshFailed", { service: t("settings.models") }),
        String(error),
        language,
      );
      toast.add({
        ...failure,
        description: `${t("settings.modelRefreshRetry")} ${failure.description}`,
      });
    } finally {
      saving.current = false;
      setRefreshing(false);
    }
  }
  async function submit() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      await window.worklens.invoke("modelSelection", {
        provider: provider.id,
        reviewed: catalog.map((m) => m.id),
        selected: [...selected],
      });
      await onSaved();
    } catch (error) {
      const failure = settingsFailure(
        t("settingsFeedback.visibilityFailed"),
        String(error),
        language,
      );
      toast.add({
        ...failure,
        description: `${t("settings.modelSelectionRetry")} ${failure.description}`,
      });
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving.current) onClose();
      }}
    >
      <DialogContent
        className="settings-dialog settings-model-dialog"
        showCloseButton={!disabled}
        aria-busy={disabled}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ProviderIcon provider={provider.id} />
            {t("settings.modelsFor", { provider: provider.name })}
          </DialogTitle>
          <DialogDescription>
            {t("settings.selectModelsDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 items-center gap-2">
          <SearchInput
            aria-label={t("settings.searchModels")}
            placeholder={t("settings.searchModelsPlaceholder")}
            value={query}
            onValueChange={setQuery}
            disabled={disabled}
          />
          <TooltipIconButton
            variant="ghost"
            size="icon-sm"
            aria-label={t("settings.refreshModelsFor", {
              provider: provider.name,
            })}
            tooltip={t("settings.refreshModels")}
            disabled={disabled}
            onClick={() => void refreshCatalog()}
          >
            <RefreshCw
              className={
                refreshing
                  ? "animate-spin motion-reduce:animate-none"
                  : undefined
              }
            />
          </TooltipIconButton>
        </div>
        <FieldSet className="settings-model-catalog">
          <FieldLegend className="sr-only">
            {t("settings.chooseModels")}
          </FieldLegend>
          <div className="settings-model-toolbar">
            <span className="settings-group-count" role="status">
              {t("settings.modelsDraftCount", {
                count: selected.size,
                total: catalog.length,
              })}
              {query.trim() && (
                <>
                  {" "}
                  ·{" "}
                  {t("settings.modelsMatchedCount", { count: matches.length })}
                </>
              )}
            </span>
            <div className="flex flex-wrap gap-1">
              <Button
                variant="ghost"
                size="xs"
                disabled={disabled || !toSelect.length}
                onClick={() =>
                  toggle(
                    toSelect.map((m) => m.id),
                    true,
                  )
                }
              >
                {t(
                  query.trim()
                    ? "settings.selectMatchingModels"
                    : "settings.selectAllModels",
                )}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={disabled || !toClear.length}
                onClick={() =>
                  toggle(
                    toClear.map((m) => m.id),
                    false,
                  )
                }
              >
                {t(
                  query.trim()
                    ? "settings.clearMatchingModels"
                    : "settings.clearModelSelection",
                )}
              </Button>
            </div>
          </div>
          <div
            className="settings-model-options"
            style={
              {
                "--model-list-height": `${Math.max(72, Math.min(380, catalog.length * 62 + 8))}px`,
              } as CSSProperties
            }
          >
            <FieldGroup className="gap-1">
              {/* Keep controls mounted while filtering; hidden results leave
                  both the layout and keyboard/accessibility navigation. */}
              {catalog.map((model) => (
                <div key={model.id} hidden={!matchedIds.has(model.id)}>
                  <ModelOption
                    model={model}
                    modelId={`${id}-${model.id}`}
                    checked={selected.has(model.id)}
                    disabled={disabled}
                    onToggle={toggle}
                    formatter={formatter}
                    t={t}
                  />
                </div>
              ))}
            </FieldGroup>
            {!matches.length && (
              <p className="settings-empty">
                {t(
                  query.trim()
                    ? "settings.noModelsMatchSearch"
                    : "settings.noModelsInCatalog",
                )}
              </p>
            )}
          </div>
        </FieldSet>
        <DialogFooter>
          <Button variant="outline" disabled={disabled} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={disabled} onClick={() => void submit()}>
            {busy && (
              <LoaderCircle
                className="animate-spin motion-reduce:animate-none"
                data-icon="inline-start"
                aria-hidden="true"
              />
            )}
            {t(busy ? "connectors.form.saving" : "common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Stable rows keep typing and individual selections from rerendering every
// checkbox and tooltip in a large provider catalog.
const ModelOption = memo(function ModelOption({
  model,
  modelId,
  checked,
  disabled,
  onToggle,
  formatter,
  t,
}: {
  model: ProviderInfo["models"][number] & { fresh: boolean };
  modelId: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (ids: string[], checked: boolean) => void;
  formatter: Intl.NumberFormat;
  t: ReturnType<typeof useAppTranslation>["t"];
}) {
  const rowDisabled = disabled || (!model.available && !checked);
  return (
    <Hint
      content={
        <span>
          {model.name}
          <br />
          {model.id}
        </span>
      }
    >
      <FieldLabel htmlFor={modelId} className="settings-model-option">
        <Field
          orientation="horizontal"
          data-disabled={rowDisabled || undefined}
        >
          <Checkbox
            id={modelId}
            aria-labelledby={`${modelId}-name`}
            aria-describedby={`${modelId}-details${!model.available ? ` ${modelId}-unavailable` : ""}`}
            checked={checked}
            disabled={rowDisabled}
            onCheckedChange={(checked) => onToggle([model.id], checked)}
          />
          <FieldContent className="min-w-0">
            <FieldTitle className="w-full min-w-0 items-start">
              <span
                id={`${modelId}-name`}
                className="min-w-0 flex-1 break-words"
              >
                {model.name}
              </span>
              {model.fresh && (
                <Badge variant="secondary">{t("settings.newModel")}</Badge>
              )}
              {!model.available && (
                <Badge variant="outline">{t("common.unavailable")}</Badge>
              )}
            </FieldTitle>
            <FieldDescription id={`${modelId}-details`}>
              {formatter.format(model.contextWindow)}
              {model.reasoning ? t("settings.thinkingSuffix") : ""}
              {model.image ? t("settings.visionSuffix") : ""}
            </FieldDescription>
            {!model.available && (
              <FieldDescription id={`${modelId}-unavailable`}>
                {t("settings.unavailableModelHint")}
              </FieldDescription>
            )}
          </FieldContent>
        </Field>
      </FieldLabel>
    </Hint>
  );
});
