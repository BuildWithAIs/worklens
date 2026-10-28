import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { Hint } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/i18n";
import { ModelMenu } from "./ModelMenu";
import { ProviderIcon } from "./ProviderIcon";
import { settingsFailure } from "./settings-notification";
import type {
  ProviderInfo,
  ReportSummaryModel,
  Settings,
  Thinking,
} from "../../../../shared/contracts";

const MAX_MODELS = 5;
const keyOf = (model: ReportSummaryModel) =>
  `${model.provider}\u0000${model.model}`;

/** Whether to summarize with AI, and the models to use, in order. */
export function ReportSettings({
  settings,
  providers,
  save,
  onManageModels,
}: {
  settings: Settings;
  providers: ProviderInfo[];
  save: (patch: Partial<Settings>) => Promise<void>;
  onManageModels: () => void;
}) {
  const { t, language } = useAppTranslation();
  const saved = useMemo(
    () => settings.reportSummary ?? { enabled: false, models: [] },
    [settings.reportSummary],
  );
  const [value, setValue] = useState(saved);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  useEffect(() => setValue(saved), [saved]);
  const data = useMemo(() => ({ settings, providers }), [settings, providers]);

  async function change(next: typeof value) {
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    setValue(next);
    try {
      await save({ reportSummary: next });
    } catch (error) {
      setValue(saved);
      toast.add(
        settingsFailure(
          t("settings.report.saveFailed"),
          String(error),
          language,
          false,
          t("settingsFeedback.unknown"),
        ),
      );
    } finally {
      saving.current = false;
      setPending(false);
    }
  }
  const move = (index: number, by: number) => {
    const models = [...value.models];
    const [item] = models.splice(index, 1);
    models.splice(index + by, 0, item);
    void change({ ...value, models });
  };
  const setThinking = (index: number, thinking: Thinking) =>
    void change({
      ...value,
      models: value.models.map((item, i) =>
        i === index ? { ...item, thinking } : item,
      ),
    });

  return (
    <div className="report-settings">
      <div className="report-settings-row">
        <span className="report-settings-copy">
          <FieldLabel htmlFor="report-summary-enabled" className="font-normal">
            {t("settings.report.enable")}
          </FieldLabel>
          <span id="report-summary-hint">
            {t("settings.report.enableHint")}
          </span>
        </span>
        <Switch
          id="report-summary-enabled"
          aria-describedby="report-summary-hint"
          aria-busy={pending}
          checked={value.enabled}
          disabled={pending}
          onCheckedChange={(enabled) => void change({ ...value, enabled })}
        />
      </div>
      {value.enabled && (
        <div className="report-settings-models">
          <div className="report-settings-heading">
            {t("settings.report.models")}
            <span>{t("settings.report.modelsHint")}</span>
          </div>
          <ol>
            {value.models.map((model, index) => (
              <li key={keyOf(model)}>
                <span className="report-settings-index">{index + 1}</span>
                <SummaryModel
                  model={model}
                  providers={providers}
                  disabled={pending}
                  onThinking={(thinking) => setThinking(index, thinking)}
                />
                <span className="report-settings-actions">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={pending || index === 0}
                    aria-label={t("settings.report.moveUp", {
                      model: model.model,
                    })}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={pending || index === value.models.length - 1}
                    aria-label={t("settings.report.moveDown", {
                      model: model.model,
                    })}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={pending}
                    aria-label={t("settings.report.remove", {
                      model: model.model,
                    })}
                    onClick={() =>
                      void change({
                        ...value,
                        models: value.models.filter((_, i) => i !== index),
                      })
                    }
                  >
                    <X />
                  </Button>
                </span>
              </li>
            ))}
          </ol>
          {value.models.length < MAX_MODELS && (
            <div className="report-settings-add">
              <ModelMenu
                data={data}
                disabled={pending}
                addLabel={t("settings.report.addModel")}
                onChange={(next) => {
                  if (value.models.some((item) => keyOf(item) === keyOf(next)))
                    return;
                  void change({ ...value, models: [...value.models, next] });
                }}
                onManage={onManageModels}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A chosen model is fixed in its row; only its thinking level changes here.
 * Another model is added below.
 */
function SummaryModel({
  model,
  providers,
  disabled,
  onThinking,
}: {
  model: ReportSummaryModel;
  providers: ProviderInfo[];
  disabled: boolean;
  onThinking: (thinking: Thinking) => void;
}) {
  const { t } = useAppTranslation();
  const provider = providers.find((item) => item.id === model.provider);
  const info = provider?.models.find((item) => item.id === model.model);
  const name = info?.name ?? model.model;
  const thinking = model.thinking ?? "off";
  return (
    <span className="report-settings-model">
      <ProviderIcon provider={model.provider} />
      <Hint content={name}>
        <span className="truncate" tabIndex={0}>
          {name}
        </span>
      </Hint>
      <span className="report-settings-provider truncate">
        {info?.available
          ? (provider?.name ?? model.provider)
          : t("common.unavailable")}
      </span>
      {info?.available && info.levels.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                className="report-settings-thinking"
                disabled={disabled}
                aria-label={t("settings.report.thinking", { model: name })}
              />
            }
          >
            {t(`models.levels.${thinking}`)}
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto">
            <DropdownMenuRadioGroup
              value={thinking}
              onValueChange={(next) => onThinking(next as Thinking)}
            >
              {info.levels.map((level) => (
                <DropdownMenuRadioItem key={level} value={level}>
                  {t(`models.levels.${level}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
  );
}
