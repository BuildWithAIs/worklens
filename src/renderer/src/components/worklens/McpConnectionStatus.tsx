import { CircleAlert, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/i18n";
import { settingsErrorDescription } from "./settings-notification";
import type { McpTestResult } from "./mcp-configuration";

export function McpConnectionStatus({ result }: { result: McpTestResult }) {
  const { t, language } = useAppTranslation();
  const needsAttention = result.state === "failed" || result.state === "signIn";
  const message =
    result.state === "passed"
      ? t("mcp.tested", { count: result.tools })
      : result.state === "failed"
        ? t("mcp.testFailure", {
            reason: settingsErrorDescription(
              result.error,
              language,
              false,
              t("settingsFeedback.mcpUnknown"),
            ),
          })
        : t(
            result.state === "testing"
              ? "mcp.testing"
              : result.state === "signIn"
                ? "mcp.needsSignIn"
                : "mcp.untested",
          );
  return (
    <p
      role="status"
      data-mcp-status={result.state}
      className={cn(
        "text-sm leading-normal text-muted-foreground",
        needsAttention && "text-[var(--warning)]",
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        {result.state === "testing" ? (
          <LoaderCircle
            className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : needsAttention ? (
          <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
        ) : null}
        <span>{message}</span>
      </span>
    </p>
  );
}
