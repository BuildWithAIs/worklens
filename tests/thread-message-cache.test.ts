import { describe, expect, it } from "vitest";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { createThreadMessageCache } from "../src/renderer/src/lib/thread-message-cache";

const user: ThreadMessageLike = {
  id: "user",
  role: "user",
  content: "Question",
};
const answer: ThreadMessageLike = {
  id: "live-text",
  role: "assistant",
  content: [{ type: "text", text: "Hello" }],
  status: { type: "running" },
  metadata: { custom: { sentAt: "2026-09-18" } },
};

describe("rendered thread message cache", () => {
  it("reuses unchanged snapshots and history while streamed text changes", () => {
    const cache = createThreadMessageCache();
    const first = cache([user, answer]);
    expect(cache(structuredClone([user, answer]))).toBe(first);
    const next = cache([
      structuredClone(user),
      { ...answer, content: "Hello world" },
    ]);
    expect(next.messages[0]).toBe(first.messages[0]);
    expect(next.messages[1].message).not.toBe(first.messages[1].message);
    expect(next.messages[1].message.content).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("preserves completion, cancellation, errors and metadata-only updates", () => {
    const cache = createThreadMessageCache();
    const initial = cache([user, answer]);
    const metadata = cache([
      user,
      { ...answer, metadata: { custom: { sentAt: "later" } } },
    ]);
    expect(metadata.messages[1].message).not.toBe(initial.messages[1].message);
    expect(metadata.messages[1].message.metadata.custom.sentAt).toBe("later");
    for (const status of [
      { type: "complete", reason: "stop" },
      { type: "incomplete", reason: "cancelled" },
      { type: "incomplete", reason: "error", error: "failed" },
    ] as const) {
      expect(
        cache([user, { ...answer, status }]).messages[1].message.status,
      ).toEqual(status);
    }
  });

  it("updates nested tool results even when the displayed text is unchanged", () => {
    const cache = createThreadMessageCache();
    const tool: ThreadMessageLike = {
      id: "tool",
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call",
          toolName: "bash",
          args: {},
          argsText: "{}",
          result: { output: "old", exitCode: 0 },
        },
      ],
    };
    const first = cache([user, tool]);
    const next = structuredClone(tool);
    if (Array.isArray(next.content) && next.content[0].type === "tool-call")
      next.content[0].result = { output: "new", exitCode: 1 };
    const result = cache([user, next]);
    expect(result.messages[1].message).not.toBe(first.messages[1].message);
    expect(result.messages[1].message.content[0]).toMatchObject({
      result: { output: "new", exitCode: 1 },
    });
  });

  it("drops replaced live nodes and relinks reordered messages", () => {
    const cache = createThreadMessageCache();
    const first = cache([user, answer]);
    const reordered = cache([answer, user]);
    expect(reordered.messages[0].parentId).toBeNull();
    expect(reordered.messages[1].parentId).toBe("live-text");
    expect(reordered.messages[0].message).toBe(first.messages[1].message);
    const completed = cache([
      user,
      {
        ...answer,
        id: "final-answer",
        status: { type: "complete", reason: "stop" },
      },
    ]);
    expect(completed.messages.map((x) => x.message.id)).toEqual([
      "user",
      "final-answer",
    ]);
    expect(cache([]).messages).toEqual([]);
    expect(cache([user]).messages[0].message).not.toBe(
      first.messages[0].message,
    );
  });
});
