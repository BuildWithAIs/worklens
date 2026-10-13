import { expect, test } from "vitest";
import { ChatUpdates } from "../src/main/chat-updates";
import { shareUnchanged } from "../src/main/structural-sharing";
import type {
  ChatEvent,
  ConversationView,
  MessageView,
} from "../src/shared/contracts";

const message = (id: string, text: string) =>
  ({ id, role: "assistant", text }) as MessageView;
const event = (
  sequence: number,
  messages: MessageView[],
  type = "message_update",
  runId = "run",
): ChatEvent => ({
  conversationId: "chat",
  runId,
  sequence,
  type,
  view: { id: "chat", messages } as unknown as ConversationView,
});

test("sends only messages after the shared prefix within a run", () => {
  const updates = new ChatUpdates();
  const first = message("1", "question");
  const second = message("2", "answer");
  expect(updates.encode(event(1, [first], "run_start"))).toMatchObject({
    view: { messages: [first] },
  });
  const streamed = updates.encode(event(2, [first, second]));
  expect(streamed.messagesFrom).toBe(1);
  expect(streamed.baseSequence).toBe(1);
  expect(streamed.view.messages).toEqual([second]);
  // The original event is not modified for in-process listeners.
  const complete = event(3, [first, message("2", "answer!")]);
  expect(updates.encode(complete).view.messages).toHaveLength(1);
  expect(complete.view.messages).toHaveLength(2);
});

test("keeps run boundaries, gaps and resets complete", () => {
  const updates = new ChatUpdates();
  const first = message("1", "question");
  updates.encode(event(1, [first], "run_start"));
  expect(updates.encode(event(3, [first])).messagesFrom).toBeUndefined();
  expect(updates.encode(event(4, [first], "run_end")).messagesFrom).toBe(
    undefined,
  );
  updates.encode(event(1, [first], "run_start", "next"));
  updates.reset();
  expect(
    updates.encode(event(2, [first], "message_update", "next")).messagesFrom,
  ).toBeUndefined();
});

test("shares unchanged items by position", () => {
  const previous = [message("1", "a"), message("2", "b")];
  const next = shareUnchanged(previous, [
    message("1", "a"),
    message("2", "changed"),
    message("3", "c"),
  ]);
  expect(next[0]).toBe(previous[0]);
  expect(next[1]).not.toBe(previous[1]);
  expect(next[2].id).toBe("3");
});
