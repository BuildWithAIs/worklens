import { DisconnectConfirmation } from "../DisconnectConfirmation";
import { LoaderCircle, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { useState } from "react";
import { useAppTranslation } from "@/i18n";
import { connectorName, type ConnectorAction } from "./connector-presentation";

export function ConnectorActions({
  service,
  action,
  missing,
  unchanged = false,
  removable,
  onAction,
}: {
  service: string;
  action: ConnectorAction | null;
  missing: boolean;
  /** Saved connection with no edits: testing stays possible, saving does not. */
  unchanged?: boolean;
  removable: boolean;
  onAction: (action: ConnectorAction) => void;
}) {
  const { t } = useAppTranslation();
  const [confirming, setConfirming] = useState(false);
  const name = connectorName(service);
  return (
    <>
      <DialogFooter>
        {removable && (
          <DisconnectConfirmation
            open={confirming}
            busy={action === "remove"}
            title={t("settings.disconnectProvider", { provider: name })}
            description={t("connectors.form.disconnectDescription", {
              service: name,
            })}
            onOpen={() => setConfirming(true)}
            onCancel={() => setConfirming(false)}
            onConfirm={() => onAction("remove")}
            trigger={
              <Button
                variant="ghost"
                className="sm:mr-auto"
                disabled={!!action}
              >
                {t("common.disconnect")}
              </Button>
            }
          />
        )}
        <Button
          variant="outline"
          disabled={!!action || missing}
          onClick={() => onAction("test")}
        >
          {action === "test" ? (
            <LoaderCircle
              className="animate-spin motion-reduce:animate-none"
              data-icon="inline-start"
              aria-hidden="true"
            />
          ) : (
            <Zap data-icon="inline-start" aria-hidden="true" />
          )}
          {t(
            action === "test"
              ? "connectors.form.testing"
              : "connectors.form.testConnection",
          )}
        </Button>
        <Button
          type="submit"
          className="w-24"
          form={`${service}-settings-form`}
          disabled={!!action || missing || unchanged}
        >
          {action === "save" && (
            <LoaderCircle
              className="animate-spin motion-reduce:animate-none"
              data-icon="inline-start"
              aria-hidden="true"
            />
          )}
          {t(action === "save" ? "connectors.form.saving" : "common.save")}
        </Button>
      </DialogFooter>
    </>
  );
}
