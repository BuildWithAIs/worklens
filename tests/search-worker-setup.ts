import { build } from "esbuild";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { TestProject } from "vitest/node";

export default async function setup(project: TestProject) {
  const root = await mkdtemp(join(tmpdir(), "worklens-search-worker-"));
  const previous = process.env.WORKLENS_TEST_SEARCH_WORKER;
  const restore = () => {
    if (previous === undefined) delete process.env.WORKLENS_TEST_SEARCH_WORKER;
    else process.env.WORKLENS_TEST_SEARCH_WORKER = previous;
  };
  try {
    await symlink(
      resolve("node_modules"),
      join(root, "node_modules"),
      "junction",
    );
    const outfile = join(root, "worker.mjs");
    const compile = () =>
      build({
        entryPoints: ["src/main/search-parser-worker.ts"],
        outfile,
        bundle: true,
        packages: "external",
        platform: "node",
        format: "esm",
      }).then(() => {});
    await compile();
    process.env.WORKLENS_TEST_SEARCH_WORKER = pathToFileURL(outfile).href;
    project.onTestsRerun(compile);
    return async () => {
      restore();
      await rm(root, { recursive: true, force: true });
    };
  } catch (error) {
    restore();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
