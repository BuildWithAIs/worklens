import { createContext } from "react";
import type { Attachment } from "@assistant-ui/react";
import type { MessageView } from "../../../../shared/contracts";

export type RecoveredEdit = {
  conversationId: string;
  messageId: string;
  text: string;
  images: import("../../../../shared/chat-images").ChatImage[];
  runId: string;
};

export const MessageEditingContext = createContext<
  | {
      editingId?: string;
      recovered?: RecoveredEdit;
      busy: boolean;
      canSend: boolean;
      messages: MessageView[];
      begin: (id: string) => void;
      cancel: () => void;
      save: (
        id: string,
        text: string,
        attachments: readonly Attachment[],
      ) => Promise<void>;
      select: (id: string, targetId: string) => Promise<void>;
    }
  | undefined
>(undefined);
