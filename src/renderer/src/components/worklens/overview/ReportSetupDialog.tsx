import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { useAppTranslation } from "@/i18n";
import { initialSummaryModels, ReportSettings } from "../ReportSettings";
import { settingsFailure } from "../settings-notification";
import type { ProviderInfo, Settings } from "../../../../../shared/contracts";

/**
 * AI summary settings for the report. The first time the report opens it asks
 * once, as a plain question; turning summaries on then shows the models.
 * Closing without choosing keeps summaries off and does not ask again.
 */
export function ReportSetupDialog({
  open,
  onOpenChange,
  settings,
  providers,
  save,
  onManageModels,
}: {
  onManageModels: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  providers: ProviderInfo[];
  save: (patch: Partial<Settings>) => Promise<void>;
}) {
  const { t, language } = useAppTranslation();
  // Decided when the dialog opens, so it does not change mid-way.
  const [firstRun, setFirstRun] = useState(!settings.reportSummary);
  const [pending, setPending] = useState(false);
  const configured = !!settings.reportSummary;
  useEffect(() => {
    if (open) setFirstRun(!configured);
  }, [open]); // Only when the dialog opens.
  const asking = firstRun && !settings.reportSummary?.enabled;
  const close = () => {
    if (!settings.reportSummary)
      void save({ reportSummary: { enabled: false, models: [] } }).catch(
        () => {},
      );
    onOpenChange(false);
  };
  const turnOn = async () => {
    setPending(true);
    try {
      await save({
        reportSummary: {
          enabled: true,
          models: initialSummaryModels(settings, providers),
        },
      });
    } catch (error) {
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
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
    >
      <DialogContent className="overview-setup-dialog">
        <DialogHeader>
          <DialogTitle>
            {asking
              ? t("overview.setup.firstTitle")
              : t("overview.setup.title")}
          </DialogTitle>
          {asking && (
            <DialogDescription>
              {t("overview.setup.description")}
            </DialogDescription>
          )}
        </DialogHeader>
        {!asking && (
          <div className="overview-setup-body">
            <ReportSettings
              settings={settings}
              providers={providers}
              save={save}
              onManageModels={onManageModels}
            />
          </div>
        )}
        <DialogFooter>
          {asking ? (
            <>
              <Button variant="outline" disabled={pending} onClick={close}>
                {t("overview.setup.notNow")}
              </Button>
              <Button disabled={pending} onClick={() => void turnOn()}>
                {t("overview.setup.turnOn")}
              </Button>
            </>
          ) : (
            <Button onClick={close}>{t("overview.setup.done")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
