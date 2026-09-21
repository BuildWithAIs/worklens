import { useRef, type ReactElement } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useAppTranslation } from "@/i18n";

export function DisconnectConfirmation({
  open,
  busy,
  title,
  description,
  onCancel,
  onConfirm,
  onOpen,
  trigger,
}: {
  open: boolean;
  busy: boolean;
  title: string;
  description: string;
  onCancel: () => void;
  onConfirm: () => void;
  onOpen?: () => void;
  trigger?: ReactElement;
}) {
  const { t } = useAppTranslation();
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) onOpen?.();
        else onCancel();
      }}
    >
      {trigger && <DialogTrigger render={trigger} />}
      <DialogContent
        className="settings-dialog settings-disconnect-dialog"
        aria-busy={busy}
        initialFocus={cancel}
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            ref={cancel}
            variant="outline"
            disabled={busy}
            onClick={onCancel}
          >
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy && (
              <LoaderCircle
                data-icon="inline-start"
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
              />
            )}
            {t(busy ? "connectors.form.disconnecting" : "common.disconnect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
