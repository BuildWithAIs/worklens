import { useState } from "react";
import { Check } from "lucide-react";
import { Item, ItemTitle } from "@/components/ui/item";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@/components/ui/radio-group";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLocale } from "@/lib/locale";
import { useDarkAppearance } from "./BackgroundEffect";
import type { Settings } from "../../../../shared/contracts";

export function BackgroundPreferences({
  settings,
  save,
  onError,
  onSuccess,
}: {
  settings: Settings;
  save: (patch: Partial<Settings>) => Promise<unknown>;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}) {
  const { t } = useLocale();
  const dark = useDarkAppearance(settings);
  const [pending, setPending] = useState(false);
  const effect = settings.backgroundEffect ?? "none";
  const tones = [
    ["violet", t("Blue violet", "蓝紫")],
    ["electric", t("Electric blue", "电光蓝")],
    ["ice", t("Glacier blue", "冰川蓝")],
  ] as const;
  const tone = settings.backgroundTone ?? "violet";
  const update = async (patch: Partial<Settings>) => {
    setPending(true);
    try {
      await save(patch);
      onSuccess(t("Saved", "已保存"));
    } catch {
      onError(t("Could not save background appearance.", "背景外观保存失败。"));
    } finally {
      setPending(false);
    }
  };
  if (!dark) return null;
  return (
    <>
      <Item size="sm" role="listitem" className="settings-entry">
        <ItemTitle className="settings-entry-title">
          {t("Background effect", "背景效果")}
        </ItemTitle>
        <NativeSelect
          aria-label={t("Background effect", "背景效果")}
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
            {t("Off", "关闭")}
          </NativeSelectOption>
          <NativeSelectOption value="surface">
            {t("Soft surface", "柔光曲面")}
          </NativeSelectOption>
          <NativeSelectOption value="fluid">
            {t("Fluid texture", "流体纹理")}
          </NativeSelectOption>
        </NativeSelect>
      </Item>
      {effect !== "none" && (
        <Item size="sm" role="listitem" className="settings-entry">
          <ItemTitle className="settings-entry-title">
            {t("Color", "颜色")}
          </ItemTitle>
          <RadioGroup
            className="background-tones"
            aria-label={t("Color palette", "色调")}
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
                  <span data-tone={value} aria-hidden="true">
                    {tone === value && <Check />}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            ))}
          </RadioGroup>
        </Item>
      )}
    </>
  );
}
