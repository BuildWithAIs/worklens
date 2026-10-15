import { useContext, useId, useMemo, useState } from "react";
import { ErrorPrimitive, useAuiState } from "@assistant-ui/react";
import {
  BanIcon,
  BotOffIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CloudAlertIcon,
  CopyIcon,
  GaugeIcon,
  ImageOffIcon,
  KeyRoundIcon,
  MessageCircleXIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  ServerCrashIcon,
  ShieldAlertIcon,
  TimerOffIcon,
  UnplugIcon,
  WalletIcon,
  WifiOffIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useAppTranslation } from "@/i18n";
import { systemText } from "@/lib/system-text";
import { cn } from "@/lib/utils";
import { parseRunError, type RunErrorKind } from "../../../../shared/run-error";
import {
  RunErrorActionsContext,
  type RunErrorActions,
} from "./run-error-context";

type Action = keyof RunErrorActions;

const kindActions: Record<RunErrorKind, Action[]> = {
  unavailable: ["retry", "chooseModel"],
  rate_limit: ["retry", "chooseModel"],
  server: ["retry"],
  network: ["retry"],
  timeout: ["retry"],
  interrupted: ["retry"],
  image_processing: ["retry"],
  auth: ["openSettings"],
  quota: ["chooseModel", "retry"],
  model_missing: ["chooseModel"],
  context_overflow: ["newChat", "chooseModel"],
  image_limit: ["newChat", "chooseModel"],
  rejected: ["chooseModel", "retry"],
  unknown: ["retry"],
  content_filter: ["editMessage"],
  refusal: ["editMessage"],
};

const actionLabels = {
  retry: "runError.retry",
  chooseModel: "runError.chooseModel",
  openSettings: "runError.openSettings",
  newChat: "runError.newChat",
  editMessage: "runError.editMessage",
} as const;

// The icon names what went wrong; the neutral card leaves urgency to the copy.
const kindIcons: Record<RunErrorKind, LucideIcon> = {
  unavailable: CloudAlertIcon,
  rate_limit: GaugeIcon,
  server: ServerCrashIcon,
  network: WifiOffIcon,
  timeout: TimerOffIcon,
  interrupted: UnplugIcon,
  image_processing: ImageOffIcon,
  auth: KeyRoundIcon,
  quota: WalletIcon,
  model_missing: BotOffIcon,
  context_overflow: ScrollTextIcon,
  image_limit: ImageOffIcon,
  rejected: MessageCircleXIcon,
  unknown: CircleAlertIcon,
  content_filter: ShieldAlertIcon,
  refusal: BanIcon,
};

// Main-process messages are written in Chinese and translated for display;
// provider text is shown as received.
const isAppText = (text: string) => /[\u3400-\u9fff]/.test(text);

export function RunErrorCard() {
  const { t, language } = useAppTranslation();
  const actions = useContext(RunErrorActionsContext);
  const isLast = useAuiState((s) => s.message.isLast);
  const raw = useAuiState((s) => {
    const status = s.message.status;
    return status?.type === "incomplete" && status.reason === "error"
      ? String(status.error ?? "")
      : "";
  });
  const error = useMemo(() => parseRunError(raw), [raw]);
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  const detail = error.code
    ? systemText(error.code, language)
    : error.detail
      ? isAppText(error.detail)
        ? systemText(error.detail, language)
        : error.detail
      : t(`runError.hints.${error.kind}`);
  const hasDetails =
    !error.code && !!error.raw && error.raw !== detail && !isAppText(error.raw);
  // Older failures stay readable, but their next steps no longer apply.
  const available = isLast
    ? kindActions[error.kind].filter((action) => actions[action])
    : [];
  const Icon = kindIcons[error.kind];

  return (
    <ErrorPrimitive.Root
      data-kind={error.kind}
      className="aui-message-error-root bg-card ring-foreground/10 mt-2 flex w-full max-w-full items-start gap-2.5 rounded-xl px-3.5 py-3 text-sm leading-5 ring-1"
    >
      <Icon
        className="text-muted-foreground mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
            <p className="aui-message-error-title text-foreground font-medium">
              {t(`runError.titles.${error.kind}`)}
            </p>
            {error.status && (
              <span className="text-muted-foreground tabular-nums">
                · {error.status}
              </span>
            )}
          </div>
          {hasDetails && (
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground -my-0.5 -me-1"
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => setOpen((value) => !value)}
            >
              {t("runError.details")}
              <ChevronDownIcon
                aria-hidden="true"
                className={cn(
                  "transition-transform motion-reduce:transition-none",
                  open && "rotate-180",
                )}
              />
            </Button>
          )}
        </div>
        <p className="aui-message-error-message text-muted-foreground mt-0.5 line-clamp-3 wrap-anywhere">
          {detail}
        </p>
        {available.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {available.map((action) => (
              <Button
                key={action}
                variant="outline"
                size="sm"
                onClick={() => actions[action]?.()}
              >
                {action === "retry" && <RefreshCwIcon aria-hidden="true" />}
                {t(actionLabels[action])}
              </Button>
            ))}
          </div>
        )}
        {hasDetails && open && (
          <div id={detailsId} className="relative mt-2">
            <pre className="bg-muted max-h-40 overflow-auto rounded-lg p-2.5 pe-9 font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere">
              {error.raw}
            </pre>
            <TooltipIconButton
              tooltip={
                isCopied ? t("common.copied") : t("runError.copyDetails")
              }
              className="absolute end-1.5 top-1.5"
              onClick={() => copyToClipboard(error.raw)}
            >
              {isCopied ? <CheckIcon /> : <CopyIcon />}
            </TooltipIconButton>
          </div>
        )}
      </div>
    </ErrorPrimitive.Root>
  );
}
