import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { requestHandlers, type RequestContext } from "../src/main/ipc";
import { LocalArtifacts } from "../src/main/local-artifacts";
import { schemas } from "../src/main/validation";

const desktop = vi.hoisted(() => ({
  open: vi.fn(),
  show: vi.fn(),
  save: vi.fn(),
}));
vi.mock("electron", () => ({
  shell: { openPath: desktop.open, showItemInFolder: desktop.show },
  dialog: { showSaveDialog: desktop.save },
  nativeTheme: {},
}));

const roots: string[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "artifact-inspection-"));
  roots.push(root);
  const artifacts = new LocalArtifacts(
    join(root, "artifacts"),
    join(root, "sessions"),
  );
  const handlers = requestHandlers({ artifacts } as RequestContext);
  const inspect = (id: string) =>
    Promise.resolve(handlers.artifact({ id, action: "inspect" }));
  return { root, artifacts, inspect };
}

test("inspect returns only an indexed, existing local file without desktop actions or writes", async () => {
  const f = await fixture();
  const file = await f.artifacts.save(
    "session-a",
    "reference-paper.pdf",
    "%PDF-1.4\nSynthetic document",
  );
  const before = await readdir(join(f.root, "artifacts", "index"));
  expect(schemas.artifact.parse({ id: file.id, action: "inspect" })).toEqual({
    id: file.id,
    action: "inspect",
  });
  expect(await f.inspect(file.id)).toEqual({ file });
  expect(await readdir(join(f.root, "artifacts", "index"))).toEqual(before);
  expect(desktop.open).not.toHaveBeenCalled();
  expect(desktop.show).not.toHaveBeenCalled();
  expect(desktop.save).not.toHaveBeenCalled();
});

test("unregistered references and removed or replaced files cannot pass inspection", async () => {
  const f = await fixture();
  await expect(f.inspect(randomUUID())).rejects.toThrow();
  const file = await f.artifacts.save(
    "session-a",
    "reference-paper.pdf",
    "%PDF-1.4\nSynthetic document",
  );
  await unlink(file.path);
  await expect(f.inspect(file.id)).rejects.toThrow();
  await mkdir(file.path);
  await expect(f.inspect(file.id)).rejects.toThrow();
  expect(desktop.open).not.toHaveBeenCalled();
  expect(desktop.show).not.toHaveBeenCalled();
  expect(desktop.save).not.toHaveBeenCalled();
});

test("inspection accepts an artifact ID rather than an arbitrary filesystem or web target", () => {
  for (const input of [
    { id: "https://docs.example.test/reference.pdf", action: "inspect" },
    { id: "/tmp/reference-paper.pdf", action: "inspect" },
    { id: randomUUID(), action: "inspect", path: "/tmp/reference-paper.pdf" },
  ])
    expect(schemas.artifact.safeParse(input).success).toBe(false);
});
