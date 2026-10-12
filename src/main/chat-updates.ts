import type { ChatEvent, MessageView } from "../shared/contracts";
import { firstChange } from "./structural-sharing";

// Streaming events repeat the whole conversation. Within a run, send only the
// messages that changed since the previous event; the renderer keeps the rest.
// Run boundaries stay complete so every run starts and ends from a full view.
export class ChatUpdates {
  private sent = new Map<
    string,
    { runId: string; sequence: number; messages: MessageView[] }
  >();
  /** The renderer lost its state, for example after a reload. */
  reset() {
    this.sent.clear();
  }
  encode(event: ChatEvent): ChatEvent {
    const previous = this.sent.get(event.conversationId);
    const messages = event.view.messages;
    if (event.type === "run_end") this.sent.delete(event.conversationId);
    else
      this.sent.set(event.conversationId, {
        runId: event.runId,
        sequence: event.sequence,
        messages,
      });
    if (
      event.type === "run_start" ||
      event.type === "run_end" ||
      previous?.runId !== event.runId ||
      previous.sequence !== event.sequence - 1
    )
      return event;
    const from = firstChange(previous.messages, messages);
    if (!from) return event;
    return {
      ...event,
      view: { ...event.view, messages: messages.slice(from) },
      messagesFrom: from,
      baseSequence: previous.sequence,
    };
  }
}
