import { afterEach, expect, test } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore, atomicJson } from "../src/main/storage";

const temps: string[] = [];
afterEach(async () => {
  for (const path of temps.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "worklens-state-"));
  temps.push(root);
  return root;
}

test("moves damaged settings aside and starts with defaults", async () => {
  const root = await fixture();
  const path = join(root, "app-state.json");
  for (const content of ["", '{"version":1,', "[]", "null"]) {
    await writeFile(path, content);
    const store = new StateStore(path);
    await store.load();
    expect(store.value.theme).toBe("system");
    expect(store.recoveredFrom).toMatch(/app-state\.json\.damaged-\d+$/);
    expect(await readFile(store.recoveredFrom!, "utf8")).toBe(content);
    await rm(store.recoveredFrom!);
    await store.update({ theme: "dark" });
    expect(JSON.parse(await readFile(path, "utf8")).theme).toBe("dark");
  }
});

test("refuses settings from a newer version without changing them", async () => {
  const root = await fixture();
  const path = join(root, "app-state.json");
  await writeFile(path, '{"version":2}');
  await expect(new StateStore(path).load()).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe('{"version":2}');
});

test("atomic writes leave no temporary files", async () => {
  const root = await fixture();
  await atomicJson(join(root, "value.json"), { saved: true });
  expect(await readdir(root)).toEqual(["value.json"]);
  await expect(
    atomicJson(join(root, "value.json", "nested.json"), {}),
  ).rejects.toThrow();
  expect(await readdir(root)).toEqual(["value.json"]);
});
