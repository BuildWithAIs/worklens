import { expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverModels, selectModels } from "../src/main/model-selection";
import { StateStore } from "../src/main/storage";
import { schemas } from "../src/main/validation";
import type { ProviderInfo, Settings } from "../src/shared/contracts";

const provider = (ids: string[], configured = true) =>
  ({
    id: "router",
    configured,
    models: ids.map((id) => ({ id })),
  }) as ProviderInfo;
const initial = (): Settings => ({
  version: 1,
  theme: "system",
  riskAccepted: true,
});
const discover = (
  state: Settings,
  ids: string[],
  configured = true,
): Settings => ({
  ...state,
  ...discoverModels(state, [provider(ids, configured)]),
});

test("first connection selects its catalog; migration preserves existing hidden models", () => {
  expect(discoverModels(initial(), [provider(["a"], false)])).toBeUndefined();
  expect(discoverModels(initial(), [provider([])])).toBeUndefined();
  const state = discover(
    { ...initial(), hiddenModels: ["router/b", "other/x"] },
    ["a", "b"],
  );
  expect(state.hiddenModels).toEqual(["router/b", "other/x"]);
  expect(state.modelCatalogs?.router).toEqual({ known: ["a", "b"], new: [] });
});

test("new IDs default hidden, survive restart, and reconnect never resets selection", async () => {
  const path = join(
    await mkdtemp(join(tmpdir(), "worklens-model-selection-")),
    "state.json",
  );
  const store = new StateStore(path);
  await store.update(discover(initial(), ["a"]));
  await store.update((state) => discoverModels(state, [provider(["a", "b"])]));
  const reopened = new StateStore(path);
  await reopened.load();
  expect(reopened.value.hiddenModels).toEqual(["router/b"]);
  expect(reopened.value.modelCatalogs?.router.new).toEqual(["b"]);
  expect(
    discoverModels(reopened.value, [provider(["a", "b"], false)]),
  ).toBeUndefined();
  expect(
    discoverModels(reopened.value, [provider(["a", "b"])]),
  ).toBeUndefined();
});

test("save clears reviewed New badges even without selecting; later discoveries and other providers survive", () => {
  let state = discover(initial(), ["a"]);
  state = discover(state, ["a", "b", "c"]);
  state.hiddenModels!.push("other/x");
  const next = {
    ...state,
    ...selectModels(state, {
      provider: "router",
      reviewed: ["a", "b"],
      selected: [],
    }),
  };
  expect(new Set(next.hiddenModels)).toEqual(
    new Set(["router/a", "router/b", "router/c", "other/x"]),
  );
  expect(next.modelCatalogs?.router.new).toEqual(["c"]);
  expect(discoverModels(next, [provider(["a", "b", "c"])])).toBeUndefined();
});

test("removed/reappearing IDs are not new again and model IDs containing slashes stay intact", () => {
  let state = discover(initial(), ["vendor/model"]);
  state = discover(state, []);
  expect(discoverModels(state, [provider(["vendor/model"])])).toBeUndefined();
  expect(
    selectModels(state, {
      provider: "router",
      reviewed: ["vendor/model"],
      selected: [],
    }).hiddenModels,
  ).toEqual(["router/vendor/model"]);
});

test("serialized provider saves preserve each other's changes and defaults", async () => {
  const store = new StateStore(
    join(await mkdtemp(join(tmpdir(), "worklens-model-queue-")), "state.json"),
  );
  const defaults = { provider: "router", model: "a", thinking: "off" as const };
  await store.update({ ...discover(initial(), ["a"]), defaults });
  await store.update((state) =>
    discoverModels(state, [{ ...provider(["b"]), id: "other" }]),
  );
  await Promise.all([
    store.update((state) =>
      selectModels(state, {
        provider: "router",
        reviewed: ["a"],
        selected: [],
      }),
    ),
    store.update((state) =>
      selectModels(state, { provider: "other", reviewed: ["b"], selected: [] }),
    ),
  ]);
  expect(new Set(store.value.hiddenModels)).toEqual(
    new Set(["router/a", "other/b"]),
  );
  expect(store.value.defaults).toEqual(defaults);
});

test("selection IPC rejects unknown models and invalid payloads", () => {
  const state = discover(initial(), ["a"]);
  expect(() =>
    selectModels(state, {
      provider: "router",
      reviewed: ["bad"],
      selected: [],
    }),
  ).toThrow();
  expect(() =>
    selectModels(state, { provider: "router", reviewed: [], selected: ["a"] }),
  ).toThrow();
  expect(
    schemas.modelSelection.safeParse({
      provider: "router",
      reviewed: [],
      selected: [],
      extra: true,
    }).success,
  ).toBe(false);
});
