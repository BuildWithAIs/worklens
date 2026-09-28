import { useRef, useState } from "react";
import { ChevronDown, LoaderCircle } from "lucide-react";
import typesafe from "@/assets/brands/typesafe.svg?url";
import { BrandIcon } from "../../ProviderIcon";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { useAppTranslation } from "@/i18n";
import { settingsFailure } from "../../settings-notification";
import type { ConversationView } from "../../../../../../shared/contracts";

/** The current chat's permission, separate from per-answer usage records. */
export function JevSessionAccess({ conversation, onChange }: {
  conversation?: ConversationView;
  onChange?: (view: ConversationView) => void;
}) {
  const { t, language } = useAppTranslation();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const state = conversation?.jevConsent;
  if (!conversation || (!state?.blocked && !state?.autoAllowed)) return null;
  async function reset(blocked: boolean) {
    if (lock.current || !conversation) return;
    lock.current = true;
    setBusy(true);
    try {
      onChange?.(await window.worklens.invoke("jevConsentReset", { conversationId: conversation.id, blocked }));
    } catch (error) {
      toast.add(settingsFailure(t("connectors.jev.consentFailed"), String(error), language));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center" data-slot="jev-session-access">
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="sm" disabled={busy} />}>
          {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin motion-reduce:animate-none" /> : <BrandIcon source={typesafe} />}
          {t(state.blocked ? "connectors.jev.chatDisabled" : "connectors.jev.chatAutomatic")}
          <ChevronDown data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" className="min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("connectors.jev.thisChatOnly")}</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => void reset(false)}>{t("connectors.jev.resumeAsking")}</DropdownMenuItem>
            {!state.blocked && <DropdownMenuItem onClick={() => void reset(true)}>{t("connectors.jev.deny")}</DropdownMenuItem>}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
