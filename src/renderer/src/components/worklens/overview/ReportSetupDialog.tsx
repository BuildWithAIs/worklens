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
import { useAppTranslation } from "@/i18n";
import { ReportSettings } from "../ReportSettings";
import type { ProviderInfo, Settings } from "../../../../../shared/contracts";

/**
 * AI summary settings for the report. The first time the report opens it asks
 * once; closing without choosing keeps summaries off and does not ask again.
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
  const { t } = useAppTranslation();
  // Decided when the dialog opens, so the title does not change mid-way.
  const [firstRun, setFirstRun] = useState(!settings.reportSummary);
  const configured = !!settings.reportSummary;
  useEffect(() => {
    if (open) setFirstRun(!configured);
  }, [open]); // Only when the dialog opens.
  const close = () => {
    if (!settings.reportSummary)
      void save({ reportSummary: { enabled: false, models: [] } }).catch(
        () => {},
      );
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
    >
      <DialogContent className="overview-setup-dialog">
        <DialogHeader>
          <DialogTitle>
            {firstRun
              ? t("overview.setup.firstTitle")
              : t("overview.setup.title")}
          </DialogTitle>
          <DialogDescription>
            {t("overview.setup.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="overview-setup-body">
          <ReportSettings
            settings={settings}
            providers={providers}
            save={save}
            onManageModels={onManageModels}
          />
        </div>
        <DialogFooter>
          {firstRun && !settings.reportSummary?.enabled && (
            <Button variant="outline" onClick={close}>
              {t("overview.setup.notNow")}
            </Button>
          )}
          <Button onClick={close}>{t("overview.setup.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
