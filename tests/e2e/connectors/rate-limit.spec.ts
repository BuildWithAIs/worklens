import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("connector cooldown survives repeated IPC tests, saves and reconnects", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-connector-cooldown-"));
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "120",
    });
    res.end(JSON.stringify({ message: "Synthetic rate limit" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env))
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/.test(key))
      delete env[key];
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: ["."],
      cwd: resolve("."),
      env: env as Record<string, string>,
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.worklens);
    for (const service of ["github", "jira", "confluence", "jev"]) {
      const result = await page.evaluate(
        async ({ service, url }) => {
          const invoke = window.worklens.invoke as (
            method: string,
            input: unknown,
          ) => Promise<unknown>;
          const input = {
            url,
            token: "synthetic-cooldown-key",
            ...(["jira", "confluence"].includes(service)
              ? { deployment: "data-center", tokenType: "classic" }
              : {}),
          };
          const errors: string[] = [];
          for (let i = 0; i < 10; i++) {
            try {
              await invoke(`${service}Test`, input);
            } catch (error) {
              errors.push(String(error));
            }
          }
          try {
            await invoke(`${service}Save`, input);
          } catch (error) {
            errors.push(String(error));
          }
          await invoke(`${service}Remove`, undefined);
          try {
            await invoke(`${service}Test`, input);
          } catch (error) {
            errors.push(String(error));
          }
          return errors;
        },
        { service, url },
      );
      expect(result).toHaveLength(12);
      expect(
        result.every((message) => /要求稍后重试|Jev is busy/.test(message)),
      ).toBe(true);
    }
    expect(requests).toHaveLength(4);
    expect(requests).toContain("GET /api/v3/user");
    expect(requests).toContain("GET /rest/api/2/myself");
    expect(requests).toContain("GET /rest/api/user/current");
    expect(requests).toContain("GET /v1/models");
  } finally {
    await app?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
