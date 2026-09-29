import { useEffect, useRef, useState } from "react";
import { ChevronDown, LoaderCircle } from "lucide-react";
import typesafe from "@/assets/brands/typesafe.svg?url";
import { BrandIcon } from "../../ProviderIcon";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { ToolCodeBlock } from "@/components/assistant-ui/elements/tool-fallback.aui";
import { toast } from "@/components/ui/toast";
import { useAppTranslation } from "@/i18n";
import { settingsFailure } from "../../settings-notification";
import type {
  ConversationView,
  JevApproval,
} from "../../../../../../shared/contracts";

export function JevConsentCards({
  requests,
  onChange,
}: {
  requests: JevApproval[];
  onChange?: (view: ConversationView) => void;
}) {
  return requests.map((request) => (
    <JevConsentCard key={request.id} request={request} onChange={onChange} />
  ));
}

function JevConsentCard({
  request,
  onChange,
}: {
  request: JevApproval;
  onChange?: (view: ConversationView) => void;
}) {
  const { t, language } = useAppTranslation();
  const [action, setAction] = useState<"allow" | "deny" | null>(null);
  const [autoAllow, setAutoAllow] = useState(false);
  const lock = useRef(false);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    card.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [request.id]);
  const titleId = `jev-consent-${request.id}`;
  const host = new URL(request.endpoint).host;
  const recipient = host === "api.typesafe.ai" ? "TypeSafe" : host;
  async function reply(allow: boolean) {
    if (lock.current) return;
    lock.current = true;
    setAction(allow ? "allow" : "deny");
    try {
      onChange?.(
        await window.worklens.invoke("jevConsentReply", {
          conversationId: request.conversationId,
          requestId: request.id,
          allow,
          autoAllow: allow && autoAllow,
        }),
      );
    } catch (error) {
      toast.add(
        settingsFailure(
          t("connectors.jev.consentFailed"),
          String(error),
          language,
        ),
      );
    } finally {
      lock.current = false;
      setAction(null);
    }
  }
  return (
    <Card
      ref={card}
      className="w-full min-w-0 max-w-xl self-start"
      size="sm"
      role="region"
      aria-labelledby={titleId}
      data-slot="jev-approval"
      aria-busy={!!action}
    >
      <CardHeader>
        <CardTitle
          id={titleId}
          role="status"
          className="flex items-center gap-2"
        >
          <BrandIcon source={typesafe} />
          {t(`connectors.jev.approvalTitles.${request.purpose}`)}
        </CardTitle>
        <CardDescription className="wrap-anywhere">
          {t("connectors.jev.approvalDescription", {
            count: request.itemCount,
            recipient,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
            <ChevronDown data-icon="inline-start" />
            {t("connectors.jev.viewPayload")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 flex min-w-0 flex-col gap-2">
              <CardDescription className="wrap-anywhere">
                {request.endpoint}
              </CardDescription>
              <div
                className="max-h-64 overflow-auto"
                tabIndex={0}
                role="region"
                aria-label={t("connectors.jev.viewPayload")}
              >
                <ToolCodeBlock text={request.payload} className="" />
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
        <Field orientation="horizontal" data-disabled={!!action}>
          <Checkbox
            id={`${titleId}-automatic`}
            checked={autoAllow}
            onCheckedChange={setAutoAllow}
            disabled={!!action}
            aria-describedby={autoAllow ? `${titleId}-scope` : undefined}
          />
          <FieldContent>
            <FieldLabel
              htmlFor={`${titleId}-automatic`}
              className="font-normal"
            >
              {t("connectors.jev.autoAllow")}
            </FieldLabel>
            {autoAllow && (
              <FieldDescription id={`${titleId}-scope`}>
                {t("connectors.jev.autoAllowDescription")}
              </FieldDescription>
            )}
          </FieldContent>
        </Field>
      </CardContent>
      <CardFooter>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!!action}
            onClick={() => void reply(true)}
          >
            {action === "allow" && (
              <LoaderCircle
                className="animate-spin motion-reduce:animate-none"
                data-icon="inline-start"
              />
            )}
            {t("connectors.jev.allow")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!!action}
            onClick={() => void reply(false)}
          >
            {action === "deny" && (
              <LoaderCircle
                className="animate-spin motion-reduce:animate-none"
                data-icon="inline-start"
              />
            )}
            {t("connectors.jev.deny")}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
