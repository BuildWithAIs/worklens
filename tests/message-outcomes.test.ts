import { expect, test } from "vitest";
import { projectMessages, withRunTiming } from "../src/main/projection";

test("persisted failed and cancelled assistant messages keep distinct outcomes", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "Hello" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Provider rejected the request",
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [],
        stopReason: "aborted",
        errorMessage: "Request aborted",
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Recovered" }],
        stopReason: "stop",
      },
    },
  ];
  const restored = projectMessages(
    withRunTiming(JSON.parse(JSON.stringify(branch))),
  );
  expect(restored[1]).toMatchObject({
    role: "assistant",
    text: "",
    status: "error",
    error: "Provider rejected the request",
  });
  expect(restored[2]).toMatchObject({ status: "cancelled" });
  expect(restored[3].status).toBeUndefined();
});

test("an empty failure without a provider reason still survives projection", () => {
  const [message] = projectMessages([
    { role: "assistant", content: [], stopReason: "error" },
  ]);
  expect(message).toMatchObject({
    role: "assistant",
    text: "",
    status: "error",
  });
  expect(message.error).toBeUndefined();
});
