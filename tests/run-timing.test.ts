import { describe, expect, it } from "vitest";
import { projectMessages, withRunTiming } from "../src/main/projection";

const marker = (customType: string, data: object) => ({ type: "custom", customType, data });
const message = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: text }] } });

describe("persisted activity timing", () => {
  it("restores separate completed and active runs without using mount time", () => {
    const branch = [
      message("legacy"),
      marker("worklens.run-start", { runId: "first", startedAt: "2026-09-12T00:00:00Z" }),
      message("first"),
      marker("worklens.run-end", { runId: "first", endedAt: "2026-09-12T00:00:47Z" }),
      marker("worklens.run-start", { runId: "second", startedAt: "2026-09-12T00:01:00Z" }),
      message("second"),
    ];
    const restored = projectMessages(withRunTiming(branch));
    expect(restored[0].runStartedAt).toBeUndefined();
    expect(restored[1]).toMatchObject({ runStartedAt: "2026-09-12T00:00:00Z", runElapsedMs: 47000 });
    expect(restored[2].runStartedAt).toBe("2026-09-12T00:01:00Z");
    expect(restored[2].runElapsedMs).toBeUndefined();
    expect(projectMessages(withRunTiming(structuredClone(branch)))).toEqual(restored);
  });

  it("does not fabricate elapsed time for invalid terminal timestamps", () => {
    const branch = [
      marker("worklens.run-start", { runId: "first", startedAt: "2026-09-12T00:00:00Z" }),
      message("first"),
      marker("worklens.run-end", { runId: "first", endedAt: "invalid" }),
    ];
    expect(projectMessages(withRunTiming(branch))[0].runElapsedMs).toBeUndefined();
  });
});
