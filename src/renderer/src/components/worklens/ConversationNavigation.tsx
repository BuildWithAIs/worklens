import { memo } from "react";
import { MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OverflowHint } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { HistoryTitle } from "./HistoryTitle";
import { useAppTranslation } from "@/i18n";
import type { Conversation, Phase } from "../../../../shared/contracts";

const active = (phase: Phase) =>
  ["generating", "tool", "compacting", "retrying", "stopping"].includes(phase);

type ConversationRowProps = {
  id: string;
  title: string;
  selected: boolean;
  running: boolean;
  unread: boolean;
  pinned: boolean;
  pinPending: boolean;
  onOpen: (id: string) => Promise<void>;
  onPin: (id: string) => Promise<void>;
  onDialog: (dialog: {
    type: "rename" | "delete";
    id: string;
    title: string;
  }) => void;
};

// Token updates do not change a row's presentation. Keep its controls and
// tooltip tree out of streaming renders, including for the running session.
const ConversationRow = memo(function ConversationRow({
  id,
  title,
  selected,
  running,
  unread,
  pinned,
  pinPending,
  onOpen,
  onPin,
  onDialog,
}: ConversationRowProps) {
  const { t } = useAppTranslation();
  return (
    <div className={`conversation-item ${selected ? "selected" : ""}`}>
      <OverflowHint content={title}>
        <Button
          variant="ghost"
          aria-current={selected ? "page" : undefined}
          aria-label={title}
          className="conversation-open"
          onClick={() => void onOpen(id)}
        >
          <span className="conversation-title">
            <HistoryTitle title={title} />
          </span>
        </Button>
      </OverflowHint>
      {running && <span className="history-loading-ring" aria-hidden="true" />}
      {unread && !running && (
        <span
          className="conversation-unread"
          role="img"
          aria-label={t("app.unreadReply")}
        />
      )}
      <div className="conversation-actions">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("app.conversationOptions", {
                  title,
                })}
              />
            }
          >
            <MoreHorizontal size={16} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right">
            <DropdownMenuGroup>
              <DropdownMenuItem
                disabled={pinPending}
                onClick={() => void onPin(id)}
              >
                {pinned ? <PinOff /> : <Pin />}
                {pinned ? t("app.unpin") : t("app.pin")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  onDialog({
                    type: "rename",
                    id,
                    title,
                  })
                }
              >
                <Pencil />
                {t("app.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() =>
                  onDialog({
                    type: "delete",
                    id,
                    title,
                  })
                }
              >
                <Trash2 />
                {t("common.delete")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
});

type ConversationNavigationProps = Pick<
  ConversationRowProps,
  "pinPending" | "onOpen" | "onPin" | "onDialog"
> & {
  conversations: Conversation[];
  pinnedConversationIds?: string[];
  selected?: string;
  unread: Set<string>;
};

export const ConversationNavigation = memo(
  function ConversationNavigation({
    conversations,
    pinnedConversationIds,
    selected,
    unread,
    pinPending,
    onOpen,
    onPin,
    onDialog,
  }: ConversationNavigationProps) {
    const { t } = useAppTranslation();
    const pinnedIds = new Set(pinnedConversationIds ?? []);
    const groups = [
      {
        key: "pinned",
        label: t("app.pinned"),
        conversations: conversations.filter((c) => pinnedIds.has(c.id)),
      },
      {
        key: "recents",
        label: t("app.recents"),
        conversations: conversations.filter((c) => !pinnedIds.has(c.id)),
      },
    ];
    return (
      <nav aria-label={t("app.conversations")} className="conversation-list">
        {groups
          .filter(
            (group) =>
              group.key === "recents" || group.conversations.length > 0,
          )
          .map((group) => (
            <section
              key={group.key}
              className="conversation-group"
              aria-label={group.label}
            >
              <div className="section-label">{group.label}</div>
              {group.key === "recents" && !conversations.length && (
                <p className="sidebar-empty">{t("app.noConversationsYet")}</p>
              )}
              {group.conversations.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  id={conversation.id}
                  title={conversation.title}
                  selected={selected === conversation.id}
                  running={active(conversation.phase)}
                  unread={unread.has(conversation.id)}
                  pinned={pinnedIds.has(conversation.id)}
                  pinPending={pinPending}
                  onOpen={onOpen}
                  onPin={onPin}
                  onDialog={onDialog}
                />
              ))}
            </section>
          ))}
      </nav>
    );
  },
  (previous, next) =>
    previous.pinnedConversationIds === next.pinnedConversationIds &&
    previous.selected === next.selected &&
    previous.unread === next.unread &&
    previous.pinPending === next.pinPending &&
    previous.onOpen === next.onOpen &&
    previous.onPin === next.onPin &&
    previous.onDialog === next.onDialog &&
    previous.conversations.length === next.conversations.length &&
    previous.conversations.every((conversation, index) => {
      const other = next.conversations[index];
      // Preserve order and every field displayed by the navigation. Message,
      // revision, usage and timestamp changes alone have no visible effect here.
      return (
        conversation.id === other.id &&
        conversation.title === other.title &&
        active(conversation.phase) === active(other.phase)
      );
    }),
);
