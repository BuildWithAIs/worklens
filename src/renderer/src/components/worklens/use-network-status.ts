import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { useAppTranslation } from "@/i18n";
import type { NetworkStatus } from "../../../../shared/contracts";

export function useNetworkStatus(openSettings: () => void) {
  const { t } = useAppTranslation();
  const [status, setStatus] = useState<NetworkStatus>({
    revision: -1,
    proxy: false,
    bypass: false,
  });
  const notification = useRef<string | undefined>(undefined);
  const dismissed = useRef(false);
  useEffect(() => {
    let active = true;
    const accept = (next: NetworkStatus) => {
      if (active)
        setStatus((previous) =>
          next.revision > previous.revision ? next : previous,
        );
    };
    const unsubscribe = window.worklens.onNetwork(accept);
    void window.worklens
      .invoke("proxyStatus", {})
      .then(accept)
      .catch(() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  // The settings row shows the same warning; once it has been seen there, the
  // notification would only repeat it until the failures clear.
  const acknowledge = useCallback(() => {
    dismissed.current = true;
    if (notification.current) toast.close(notification.current);
    notification.current = undefined;
  }, []);
  useEffect(() => {
    if (!status.proxy && !status.bypass) {
      if (notification.current) toast.close(notification.current);
      notification.current = undefined;
      dismissed.current = false;
      return;
    }
    if (dismissed.current) return;
    const options = {
      type: "warning" as const,
      timeout: 0,
      title: t("settings.networkRequestFailed"),
      description: t("settings.networkCheckSettings"),
      actionProps: {
        children: t("app.openSettings"),
        onClick: () => {
          acknowledge();
          openSettings();
        },
      },
      onClose: () => {
        dismissed.current = true;
      },
    };
    if (notification.current) toast.update(notification.current, options);
    else notification.current = toast.add(options);
  }, [status.proxy, status.bypass, t, openSettings, acknowledge]);
  useEffect(
    () => () => {
      if (notification.current) toast.close(notification.current);
    },
    [],
  );
  return { status, acknowledge };
}
