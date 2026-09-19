import { useEffect, useRef, useState } from "react";
import { Item, ItemTitle } from "@/components/ui/item";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Slider } from "@base-ui/react/slider";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@/components/ui/radio-group";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppTranslation } from "@/i18n";
import type { Settings } from "../../../../shared/contracts";

export function BackgroundPreferences({
  settings,
  save,
  onError,
  onPreview,
}: {
  settings: Settings;
  save: (patch: Partial<Settings>) => Promise<unknown>;
  onError: (message: string) => void;
  onPreview: (value: number | null) => void;
}) {
  const { t } = useAppTranslation();
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const [draft, setDraft] = useState<number | null>(null);
  useEffect(() => () => onPreview(null), [onPreview]);
  const effect = settings.backgroundEffect ?? "none";
  // Retain stored electric/ice IDs so existing preferences remain valid.
  const tones = [
    ["violet", t("appearance.blueViolet")],
    ["electric", t("appearance.jade")],
    ["ice", t("appearance.silverMist")],
    ["sunset", t("appearance.dusk")],
  ] as const;
  const tone = settings.backgroundTone ?? "violet";
  const savedIntensity =
    effect === "none" ? 50 : (settings.backgroundIntensity?.[effect] ?? 50);
  const intensity = draft ?? savedIntensity;
  const preview = (value: number) => {
    setDraft(value);
    onPreview(value);
  };
  const commitIntensity = async (value: number) => {
    if (effect === "none" || saving.current) return;
    if (value === savedIntensity) {
      setDraft(null);
      onPreview(null);
      return;
    }
    saving.current = true;
    preview(value);
    await update({
      backgroundIntensity: { ...settings.backgroundIntensity, [effect]: value },
    });
    saving.current = false;
    setDraft(null);
    onPreview(null);
  };
  const update = async (patch: Partial<Settings>) => {
    setPending(true);
    try {
      await save(patch);
    } catch {
      onError(t("appearance.couldNotSaveBackgroundAppearance"));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <Item size="sm" role="listitem" className="settings-entry">
        <ItemTitle className="settings-entry-title">
          {t("appearance.backgroundEffect")}
        </ItemTitle>
        <NativeSelect
          aria-label={t("appearance.backgroundEffect")}
          value={effect}
          disabled={pending}
          onChange={(event) =>
            void update({
              backgroundEffect: event.target
                .value as Settings["backgroundEffect"],
            })
          }
        >
          <NativeSelectOption value="none">
            {t("appearance.off")}
          </NativeSelectOption>
          <NativeSelectOption value="surface">
            {t("appearance.softSurface")}
          </NativeSelectOption>
          <NativeSelectOption value="aurora">
            {t("appearance.aurora")}
          </NativeSelectOption>
          <NativeSelectOption value="fluid">
            {t("appearance.fluidTexture")}
          </NativeSelectOption>
        </NativeSelect>
      </Item>
      {effect !== "none" && (
        <>
          <Item size="sm" role="listitem" className="settings-entry">
            <ItemTitle className="settings-entry-title">
              {t("appearance.color")}
            </ItemTitle>
            <RadioGroup
              className="background-tones"
              aria-label={t("appearance.colorPalette")}
              value={tone}
              disabled={pending}
              onValueChange={(value) =>
                void update({
                  backgroundTone: value as Settings["backgroundTone"],
                })
              }
            >
              {tones.map(([value, label]) => (
                <Tooltip key={value}>
                  <TooltipTrigger
                    render={
                      <Radio.Root
                        value={value}
                        nativeButton
                        aria-label={label}
                        className="background-tone"
                        render={<Button variant="ghost" size="icon-sm" />}
                      />
                    }
                  >
                    <span data-tone={value} aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent>{label}</TooltipContent>
                </Tooltip>
              ))}
            </RadioGroup>
          </Item>
          <Item size="sm" role="listitem" className="settings-entry">
            <ItemTitle className="settings-entry-title">
              {t("appearance.intensity")}
            </ItemTitle>
            <div className="background-intensity-controls" data-tone={tone}>
              <Slider.Root
                className="background-intensity-slider"
                value={intensity}
                min={0}
                max={100}
                step={1}
                disabled={pending}
                onPointerCancel={() => {
                  if (saving.current) return;
                  setDraft(null);
                  onPreview(null);
                }}
                onValueChange={preview}
                onValueCommitted={(value) => void commitIntensity(value)}
              >
                <Slider.Control className="background-intensity-control">
                  <Slider.Track className="background-intensity-track">
                    <Slider.Indicator className="background-intensity-indicator" />
                    <Slider.Thumb
                      className="background-intensity-thumb"
                      aria-label={t("appearance.intensity")}
                    />
                  </Slider.Track>
                </Slider.Control>
              </Slider.Root>
              <span className="background-intensity-value" aria-hidden="true">
                {intensity}
              </span>
            </div>
          </Item>
        </>
      )}
    </>
  );
}
