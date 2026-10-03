import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import { settingsFailure } from "./settings-notification";
import { Switch } from "@/components/ui/switch";
import { FieldLabel } from "@/components/ui/field";
import { Item, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item";
import { useAppTranslation } from "@/i18n";
import type { Settings } from "../../../../shared/contracts";

export function CodeModeSetting({
  enabled,
  save,
}: {
  enabled: boolean;
  save: (patch: Partial<Settings>) => Promise<void>;
}) {
  const { t, language } = useAppTranslation();
  const [checked, setChecked] = useState(enabled);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  useEffect(() => setChecked(enabled), [enabled]);
  async function change(value: boolean) {
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    setChecked(value);
    try {
      await save({ codemodeEnabled: value });
    } catch (error) {
      setChecked(enabled);
      toast.add(
        settingsFailure(
          t("settings.codeModeFailed"),
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
  return (
    <section className="settings-section">
      <h2 className="settings-group-bar" data-slot="settings-section-title">
        {t("settings.toolExecution")}
      </h2>
      <ItemGroup className="settings-list">
        <Item size="sm" role="listitem" className="settings-entry">
          <ItemContent className="settings-entry-copy">
            <ItemTitle className="settings-entry-title">
              <FieldLabel htmlFor="codemode-enabled" className="font-normal">
                {t("settings.codeMode")}
              </FieldLabel>
              <Hint content={t("settings.codeModeDescription")}>
                <Button
                  variant="hint"
                  size="icon-xs"
                  className="size-5"
                  aria-label={t("settings.aboutCodeMode")}
                  aria-describedby="codemode-description"
                >
                  <Info aria-hidden="true" />
                </Button>
              </Hint>
            </ItemTitle>
            <span className="sr-only" id="codemode-description">
              {t("settings.codeModeDescription")}
            </span>
          </ItemContent>
          <Switch
            id="codemode-enabled"
            aria-label={t("settings.codeMode")}
            aria-describedby="codemode-description"
            aria-busy={pending}
            checked={checked}
            disabled={pending}
            onCheckedChange={(value) => void change(value)}
          />
        </Item>
      </ItemGroup>
    </section>
  );
}
