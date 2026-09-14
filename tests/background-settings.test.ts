import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/main/storage";
import { schemas } from "../src/main/validation";

test("background preferences preserve legacy settings and survive reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-background-"));
  try {
    const store = new StateStore(join(root, "settings.json"));
    await store.load();
    expect(store.value.backgroundEffect).toBeUndefined();
    await store.update({ theme: "dark", pinnedConversationIds: ["saved"] });
    await store.update(
      schemas.settings.parse({
        backgroundEffect: "fluid",
        backgroundTone: "ice",
      }),
    );
    const restored = new StateStore(join(root, "settings.json"));
    await restored.load();
    expect(restored.value).toMatchObject({
      backgroundEffect: "fluid",
      backgroundTone: "ice",
      theme: "dark",
      pinnedConversationIds: ["saved"],
    });
    await restored.update({ backgroundEffect: "none" });
    await store.load();
    expect(store.value.backgroundEffect).toBe("none");
    expect(store.value.backgroundTone).toBe("ice");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("background input accepts only supported settings", () => {
  for (const backgroundEffect of ["none", "surface", "fluid"]) {
    for (const backgroundTone of ["violet", "electric", "ice"]) {
      expect(
        schemas.settings.safeParse({ backgroundEffect, backgroundTone })
          .success,
      ).toBe(true);
    }
  }
  for (const patch of [
    { backgroundEffect: "external" },
    { backgroundTone: "red" },
    { backgroundEffect: null },
    { backgroundIntensity: 1 },
  ]) {
    expect(schemas.settings.safeParse(patch).success).toBe(false);
  }
});
