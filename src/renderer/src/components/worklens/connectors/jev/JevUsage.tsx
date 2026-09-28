import { useMemo } from "react";
import { useAuiState } from "@assistant-ui/react";
import { ChevronDown } from "lucide-react";
import typesafe from "@/assets/brands/typesafe.svg?url";
import { BrandIcon } from "../../ProviderIcon";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { ToolCodeBlock } from "@/components/assistant-ui/elements/tool-fallback.aui";
import { useAppTranslation } from "@/i18n";
import "./jev-usage.css";
import type {
  MessageView,
  JevPurpose,
} from "../../../../../../shared/contracts";

type JevCall = { id: string; purpose: JevPurpose; output: string };
const purposes: Record<string, JevPurpose> = {
  jev_classify: "classify",
  jev_rank: "rank",
  jev_check: "check",
};
export function successfulJevCalls(messages: MessageView[]): JevCall[] {
  return messages.flatMap((message) => {
    const purpose = purposes[message.toolName ?? ""];
    if (message.role !== "tool" || message.status !== "success" || !purpose)
      return [];
    try {
      // Declined tools also finish normally; only an actual successful evaluation counts.
      if (JSON.parse(message.text).status !== "success") return [];
      return [{ id: message.id, purpose, output: message.text }];
    } catch {
      return [];
    }
  });
}

function readCall(call: JevCall) {
  try {
    const parsed: unknown = JSON.parse(call.output);
    const answers =
      parsed !== null && typeof parsed === "object" && "answers" in parsed
        ? parsed.answers
        : undefined;
    const itemCount =
      answers !== null && typeof answers === "object" && !Array.isArray(answers)
        ? Object.keys(answers).length
        : undefined;
    return { ...call, itemCount, formatted: JSON.stringify(parsed, null, 2) };
  } catch {
    return { ...call, itemCount: undefined, formatted: call.output };
  }
}
type PresentedCall = ReturnType<typeof readCall>;

function JevResponse({ call }: { call: PresentedCall }) {
  return (
    <ToolCodeBlock text={call.formatted} variant="embedded" language="json" />
  );
}

export function JevUsage() {
  const { t } = useAppTranslation();
  const calls = useAuiState((s) => s.message.metadata.custom.jevCalls) as
    | JevCall[]
    | undefined;
  const presented = useMemo(() => calls?.map(readCall) ?? [], [calls]);
  if (!presented.length) return null;
  const summary = [
    ...new Set(
      presented.map(({ purpose }) => t(`connectors.jev.purposes.${purpose}`)),
    ),
  ].join(" · ");
  const label = `${t("connectors.jev.used")} · ${summary}`;
  const caption = (call: PresentedCall) =>
    [
      t(`connectors.jev.purposes.${call.purpose}`),
      call.itemCount === undefined
        ? undefined
        : t("connectors.jev.resultCount", { count: call.itemCount }),
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <Popover>
      <Hint content={label}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label={label}
              data-slot="jev-usage"
            />
          }
        >
          <BrandIcon source={typesafe} /> Jev
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        align="start"
        sideOffset={10}
        className="jev-usage-popover w-80 min-w-0 max-w-[calc(100vw-2rem)] gap-3 border-border p-4 shadow-sm ring-0"
        aria-label={t("connectors.jev.used")}
      >
        <div className="flex shrink-0 flex-col gap-1">
          <p className="font-medium">Jev</p>
          <p className="text-muted-foreground">
            {presented.length === 1
              ? caption(presented[0])
              : t("connectors.jev.callCount", { count: presented.length })}
          </p>
        </div>
        <div
          className="jev-usage-response"
          data-single={presented.length === 1}
          tabIndex={presented.length === 1 ? undefined : 0}
          role="region"
          aria-label={t("connectors.jev.response")}
        >
          {presented.length === 1 ? (
            <JevResponse call={presented[0]} />
          ) : (
            presented.map((call, index) => (
              <Collapsible
                key={call.id}
                defaultOpen={index === 0}
                className="min-w-0 shrink-0"
              >
                <CollapsibleTrigger
                  render={
                    <Button variant="ghost" size="sm" className="max-w-full" />
                  }
                >
                  <ChevronDown data-icon="inline-start" />
                  <span className="truncate">
                    {index + 1}. {caption(call)}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="pt-4">
                    <JevResponse call={call} />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
