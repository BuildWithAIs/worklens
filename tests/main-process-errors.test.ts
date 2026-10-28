import { expect, test } from "vitest";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

test("immediate native TCP failures reach requests and allow a subsequent request", async () => {
  const result = await build({
    entryPoints: ["tests/fixtures/network-connect-error.mjs"],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    write: false,
  });
  const { stdout, stderr } = await run(
    process.execPath,
    ["--input-type=module", "-e", result.outputFiles[0].text],
    { timeout: 10000 },
  );
  expect(stdout).toContain(
    "request failures handled; subsequent request succeeded",
  );
  expect(stderr).toBe("");
});

test.each(["exception", "rejection"])(
  "the monitor records a %s without swallowing it or logging secrets",
  async (kind) => {
    const result = await build({
      stdin: {
        contents: `import { monitorProcessErrors } from './src/main/process-errors';
        monitorProcessErrors(); monitorProcessErrors();
        const error = Object.assign(new Error('synthetic-secret-must-not-be-logged'), {code:'EADDRNOTAVAIL'});
        ${kind === "exception" ? "setImmediate(() => { throw error; });" : "Promise.reject(error);"}`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
    });
    // Node's own default stack still contains its error message; check only our
    // diagnostic line. A nonzero exit proves neither failure was swallowed.
    const failure = await run(process.execPath, [
      "-e",
      result.outputFiles[0].text,
    ]).catch((error) => error);
    expect(failure.code).toBe(1);
    const lines = failure.stderr
      .split("\n")
      .filter((line: string) => line.startsWith("WorkLens:"));
    expect(lines).toEqual([
      `WorkLens: uncaught main-process error; origin=${kind === "exception" ? "uncaughtException" : "unhandledRejection"}; code=EADDRNOTAVAIL`,
    ]);
  },
);
