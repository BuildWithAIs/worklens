import { useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  type ThreadMessage,
  type Attachment,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessageNotSentError,
  useAuiState,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import {
  ComposerAddAttachment,
  ComposerAttachments,
} from "@/components/assistant-ui/elements/attachment.aui";
import { ChatImageContext, createImageAdapter } from "@/lib/chat-images";
import { useAppTranslation } from "@/i18n";
import { systemText } from "@/lib/system-text";
import { MessageEditingContext } from "./message-editing-context";

// An independent draft keeps editing, attachment limits and failures isolated
// from the bottom composer. It uses the same composer and attachment components.
export function MessageEditor() {
  const editing = useContext(MessageEditingContext)!;
  const images = useContext(ChatImageContext);
  const { t } = useAppTranslation();
  const message = useAuiState((s) => s.message);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const attachmentState = useRef<Parameters<typeof createImageAdapter>[0]>(
    () => ({ supported: images.supported, disabled: false, attachments: [] }),
  );
  const adapter = useMemo(
    () => createImageAdapter(() => attachmentState.current()),
    [],
  );
  const saveDraft = async (
    text: string,
    attachments: readonly Attachment[],
  ) => {
    if (saving || editing.busy || !editing.canSend) return;
    setSaving(true);
    setError(undefined);
    try {
      await editing.save(message.id, text, attachments);
      editing.cancel();
    } catch (error) {
      setError(String(error));
      throw new MessageNotSentError();
    } finally {
      setSaving(false);
    }
  };
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages: [],
    isDisabled: saving || editing.busy,
    isSendDisabled: !editing.canSend,
    adapters: { attachments: adapter },
    onNew: async (draft) =>
      saveDraft(
        draft.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
        draft.attachments ?? [],
      ),
  });
  const save = () => {
    const draft = runtime.thread.composer.getState();
    if (
      !draft.canSend ||
      draft.attachments.some(
        (image) =>
          !images.supported ||
          image.status.type === "running" ||
          image.status.type === "incomplete",
      )
    )
      return;
    // Keep the inline draft visible until IPC accepts it, including on failure.
    void saveDraft(draft.text, draft.attachments).catch(() => {});
  };
  attachmentState.current = () => ({
    supported: images.supported,
    disabled: saving || editing.busy,
    attachments: runtime.thread.composer.getState().attachments,
  });
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    runtime.thread.composer.setText(
      editing.recovered?.text ??
        message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
    );
    const attachments = editing.recovered
      ? editing.recovered.images.map((image) => ({
          name: image.name,
          contentType: image.mimeType,
          content: [
            {
              type: "image" as const,
              image: `data:${image.mimeType};base64,${image.data}`,
            },
          ],
        }))
      : (message.attachments ?? []);
    for (const attachment of attachments)
      void runtime.thread.composer.addAttachment({
        type: "image",
        name: attachment.name,
        contentType: attachment.contentType,
        content: attachment.content,
      });
  }, [message, runtime, editing.recovered]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatImageContext.Provider value={{ ...images, reportError: setError }}>
        <div
          data-slot="aui_edit-composer-wrapper"
          className="flex flex-col px-2"
        >
          <div className="ms-auto w-full max-w-(--user-message-max-width)">
            <ComposerPrimitive.Root
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
              className="aui-edit-composer-root border-border/60 dark:border-muted-foreground/15 flex w-full flex-col rounded-(--composer-radius) border bg-(--composer-bg)"
            >
              <ComposerPrimitive.AttachmentDropzone className="flex flex-col p-2">
                <ComposerAttachments />
                <ComposerPrimitive.Input
                  aria-label={t("thread.edit")}
                  className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-2 pt-1 pb-2 text-sm outline-none"
                  autoFocus
                  submitOnEnter={false}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Escape" &&
                      !event.nativeEvent.isComposing &&
                      !saving &&
                      !editing.busy
                    ) {
                      event.preventDefault();
                      editing.cancel();
                    }
                  }}
                />
                {error && <EditError message={error} />}
                <div className="aui-edit-composer-footer flex items-center gap-1.5">
                  <ComposerAddAttachment />
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={saving || editing.busy}
                      onClick={editing.cancel}
                    >
                      {t("common.cancel")}
                    </Button>
                    <EditorSend onSave={save} />
                  </div>
                </div>
              </ComposerPrimitive.AttachmentDropzone>
            </ComposerPrimitive.Root>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("thread.editConsequences")}
            </p>
          </div>
        </div>
      </ChatImageContext.Provider>
    </AssistantRuntimeProvider>
  );
}

function EditorSend({ onSave }: { onSave: () => void }) {
  const { t } = useAppTranslation();
  const { supported } = useContext(ChatImageContext);
  const canSend = useAuiState(
    (s) => s.composer.canSend && !s.thread.isDisabled,
  );
  const blocked = useAuiState((s) =>
    s.composer.attachments.some(
      (image) =>
        !supported ||
        image.status.type === "running" ||
        image.status.type === "incomplete",
    ),
  );
  return (
    <Button
      size="sm"
      type="button"
      disabled={blocked || !canSend}
      onClick={onSave}
    >
      {t("thread.saveAndRegenerate")}
    </Button>
  );
}

function EditError({ message }: { message: string }) {
  const { language } = useAppTranslation();
  return (
    <p role="alert" className="px-2 pb-2 text-xs text-destructive">
      {systemText(message, language)}
    </p>
  );
}
