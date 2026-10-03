import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Hint } from "@/components/ui/tooltip";
import type {
  TavilyCreditUsage,
  TavilyUsageState,
} from "../../../../../../shared/contracts";
import { useAppTranslation, languageTag } from "@/i18n";
import { Button } from "@/components/ui/button";
import "../../usage.css";

function CreditMeter({
  label,
  value,
}: {
  label: string;
  value: TavilyCreditUsage;
}) {
  const { t, language } = useAppTranslation();
  const format = (number: number | null) =>
    number === null
      ? "—"
      : new Intl.NumberFormat(languageTag(language)).format(number);
  const text = t("connectors.tavily.credits", {
    used: format(value.used),
    limit: format(value.limit),
  });
  const known = value.used !== null && value.limit !== null && value.limit > 0;
  const percent = known ? Math.min(100, (value.used! / value.limit!) * 100) : 0;
  return (
    <div data-slot="tavily-credit-meter">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
        <span className="min-w-0 break-words">{label}</span>
        <span className="ml-auto shrink-0 tabular-nums">{text}</span>
      </div>
      <div
        className="usage-progress"
        role={known ? "meter" : undefined}
        aria-label={known ? label : undefined}
        aria-valuemin={known ? 0 : undefined}
        aria-valuemax={known ? value.limit! : undefined}
        aria-valuenow={known ? Math.min(value.used!, value.limit!) : undefined}
        aria-valuetext={known ? text : undefined}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function TavilyUsage({
  plan,
  revision = 0,
}: {
  plan?: string;
  revision?: number;
}) {
  const { t, language } = useAppTranslation();
  const [state, setState] = useState<TavilyUsageState>();
  const [pending, setPending] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const manual = useRef(false);
  const usage = state?.usage;
  const refreshAfter = state?.refreshAfter ?? 0;
  useEffect(() => {
    if (refreshAfter <= Date.now()) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      refreshAfter - Date.now() + 1,
    );
    return () => window.clearTimeout(timer);
  }, [refreshAfter]);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let due = 0;
    let timer: number | undefined;
    const schedule = (at: number) => {
      due = at;
      window.clearTimeout(timer);
      timer = window.setTimeout(wake, Math.max(1000, at - Date.now()));
    };
    const load = async (refresh = false) => {
      if (!active || inFlight || document.hidden) return;
      inFlight = true;
      setPending(true);
      try {
        const next = await window.worklens.invoke(
          "tavilyUsage",
          refresh ? { refresh: true } : undefined,
        );
        if (!active) return;
        setState(next);
        schedule(
          next.error
            ? Math.max(Date.now() + 60_000, next.refreshAfter)
            : (next.usage?.expiresAt ?? Date.now() + 300_000),
        );
      } catch {
        if (!active) return;
        const retryAt = Date.now() + 60_000;
        setState((previous) => ({
          usage: previous?.usage,
          error: "unavailable",
          refreshAfter: retryAt,
        }));
        schedule(retryAt);
      } finally {
        inFlight = false;
        if (active) {
          setPending(false);
          setNow(Date.now());
        }
      }
    };
    function wake() {
      if (!document.hidden && Date.now() >= due) void load();
    }
    const refresh = manual.current;
    manual.current = false;
    void load(refresh);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      active = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [attempt, revision]);
  const formatTime = (time: number) =>
    new Intl.DateTimeFormat(languageTag(language), {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(time);
  const disabled = pending || now < refreshAfter;
  const hint =
    now < refreshAfter
      ? t("connectors.tavily.refreshAvailable", {
          time: formatTime(refreshAfter),
        })
      : t("connectors.tavily.refreshUsage");
  return (
    <div
      className="tavily-credit-usage flex flex-col gap-2"
      aria-busy={pending}
    >
      <CreditMeter
        label={usage?.plan || plan || t("connectors.tavily.plan")}
        value={usage?.included ?? { used: null, limit: null }}
      />
      {usage?.paygo && (
        <CreditMeter
          label={t("connectors.tavily.payAsYouGo")}
          value={usage.paygo}
        />
      )}
      <div
        className="text-muted-foreground flex items-center justify-between gap-2 text-xs"
        role="status"
      >
        <div className="min-w-0">
          {state?.error && (
            <span className="mr-2">
              {t(
                state.error === "rate_limit"
                  ? "connectors.tavily.usageLimited"
                  : usage
                    ? "connectors.tavily.usageUpdateFailed"
                    : "connectors.tavily.usageFailed",
              )}
            </span>
          )}
          {usage && (
            <span
              title={new Intl.DateTimeFormat(languageTag(language), {
                dateStyle: "medium",
                timeStyle: "medium",
              }).format(usage.fetchedAt)}
            >
              {t("connectors.tavily.usageUpdated", {
                time: formatTime(usage.fetchedAt),
              })}
            </span>
          )}
        </div>
        <Hint content={hint}>
          <span
            className="inline-flex"
            tabIndex={disabled ? 0 : undefined}
            aria-label={disabled ? hint : undefined}
          >
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={disabled}
              aria-label={t("connectors.tavily.refreshUsage")}
              onClick={() => {
                manual.current = true;
                setAttempt((value) => value + 1);
              }}
            >
              <RefreshCw
                className={
                  pending ? "size-4 motion-safe:animate-spin" : "size-4"
                }
              />
            </Button>
          </span>
        </Hint>
      </div>
    </div>
  );
}
