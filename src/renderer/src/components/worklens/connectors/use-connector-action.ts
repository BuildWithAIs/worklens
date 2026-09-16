import { useState } from "react";
import type { ConnectorAction } from "./connector-presentation";
import type { useConnectorForm } from "./connector-form";

type Options = {
  validation: ReturnType<typeof useConnectorForm>;
  test: () => Promise<string>;
  save: () => Promise<unknown>;
  remove: () => Promise<unknown>;
  afterSave: () => void;
  afterRemove: () => void;
  refresh: () => Promise<unknown>;
  onSuccess: (message: string) => void;
  onClose: () => void;
  savedMessage: string;
  removedMessage: string;
};

// Share the lifecycle, while each connector owns its typed IPC calls and form data.
export function useConnectorAction(options: Options) {
  const [action, setAction] = useState<ConnectorAction | null>(null);
  const busy = action !== null;
  const { validation, refresh, onSuccess, onClose } = options;
  async function act(next: ConnectorAction) {
    if (busy) return;
    if (next === "save" && validation.unchanged) return;
    if (next !== "remove" && !validation.validate()) return;
    setAction(next);
    validation.reset();
    try {
      if (next === "test") {
        validation.notifyConnected(await options.test());
      } else {
        if (next === "save") await options.save();
        else await options.remove();
        await refresh();
        // Clear the form only once the parent holds the new connection, so a
        // touched, now-empty field is not flagged as missing against the old one.
        if (next === "save") options.afterSave();
        else options.afterRemove();
        onSuccess(
          next === "save" ? options.savedMessage : options.removedMessage,
        );
        onClose();
      }
    } catch (error) {
      if (next === "save") await refresh().catch(() => {});
      const message = validation.errorMessage(error, true);
      if (message) validation.notifyFailure(message, next);
    } finally {
      setAction(null);
    }
  }
  return { action, busy, act };
}
