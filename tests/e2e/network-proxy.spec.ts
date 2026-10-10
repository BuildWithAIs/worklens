import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function listen(server: Server) {
  return new Promise<number>((done) =>
    server.listen(0, "127.0.0.1", () =>
      done((server.address() as AddressInfo).port),
    ),
  );
}

test("Electron routes main-process requests, sessions and child environments through the saved proxy", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-proxy-desktop-"));
  const target = createServer((request, response) =>
    response.end(`ok:${request.headers.host}`),
  );
  const targetPort = await listen(target);
  const tunnels: string[] = [];
  // Tunnels every CONNECT to the local target, so a fake hostname only
  // resolves when the request went through this proxy.
  const proxy = createServer();
  proxy.on("connect", (request, socket, head) => {
    tunnels.push(request.url ?? "");
    const upstream = connect(targetPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  const proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
  const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env))
    if (
      /_PROXY$/i.test(key) ||
      /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/.test(key)
    )
      delete env[key];
  let app: ElectronApplication | undefined;
  const launch = async () => {
    app = await electron.launch({
      args: ["."],
      cwd: resolve("."),
      env: env as Record<string, string>,
    });
    const page = await app.firstWindow();
    await expect(page.locator(".sidebar")).toBeVisible();
    return { app, page };
  };
  const mainState = (application: ElectronApplication) =>
    application.evaluate(async ({ session }) => ({
      env: process.env.HTTPS_PROXY,
      noProxy: process.env.NO_PROXY,
      session: await session.defaultSession.resolveProxy("https://example.com"),
    }));
  try {
    let { app: application, page } = await launch();
    expect(
      await page.evaluate(() => window.worklens.invoke("proxyDetect", {})),
    ).toEqual(expect.any(Object));

    await page.evaluate(
      (url) =>
        window.worklens.invoke("settings", {
          proxy: { mode: "custom", url, bypass: "internal.example" },
        }),
      proxyUrl,
    );
    expect(await mainState(application)).toEqual({
      env: proxyUrl,
      noProxy: "localhost,127.0.0.1,::1,internal.example",
      session: `PROXY ${proxyUrl.replace("http://", "")}`,
    });
    expect(
      await application.evaluate(async () =>
        (await fetch("http://worklens.test/")).text(),
      ),
    ).toBe("ok:worklens.test");
    expect(tunnels).toEqual(["worklens.test:80"]);

    // The saved proxy is applied at startup, before services make requests.
    await application.close();
    ({ app: application, page } = await launch());
    expect((await mainState(application)).env).toBe(proxyUrl);

    await page.evaluate(() =>
      window.worklens.invoke("settings", { proxy: { mode: "off" } }),
    );
    expect(await mainState(application)).toEqual({
      env: undefined,
      noProxy: undefined,
      session: "DIRECT",
    });
    await expect(
      application.evaluate(() => fetch("http://worklens.test/")),
    ).rejects.toThrow();
    expect(tunnels).toEqual(["worklens.test:80"]);
  } finally {
    await app?.close();
    await new Promise((done) => proxy.close(done));
    await new Promise((done) => target.close(done));
  }
});
