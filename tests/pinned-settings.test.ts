import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/main/storage";
import { schemas } from "../src/main/validation";

test("pinned settings survive reload and preserve other preferences", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-pins-"));
  try {
    const store = new StateStore(join(root, "settings.json"));
    await store.load();
    expect(store.value.pinnedConversationIds).toBeUndefined();
    await store.update({ theme: "dark", pinnedConversationIds: ["first", "second"] });
    const restored = new StateStore(join(root, "settings.json"));
    await restored.load();
    expect(restored.value).toMatchObject({ theme: "dark", pinnedConversationIds: ["first", "second"] });
    await restored.update({ pinnedConversationIds: [] });
    await store.load();
    expect(store.value.pinnedConversationIds).toEqual([]);
    expect(store.value.theme).toBe("dark");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pin input validates IDs and keeps the settings contract strict", () => {
  expect(schemas.settings.parse({ pinnedConversationIds: ["abc-123"] })).toEqual({ pinnedConversationIds: ["abc-123"] });
  for (const value of [["../file"], [1], "abc", Array(2001).fill("a")]) {
    expect(schemas.settings.safeParse({ pinnedConversationIds: value }).success).toBe(false);
  }
});
