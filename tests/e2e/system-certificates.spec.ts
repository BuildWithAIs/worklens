import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("the desktop app trusts operating system root certificates in Node", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-system-ca-"));
  const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_USE_SYSTEM_CA;
  const app = await electron.launch({
    args: ["."],
    cwd: resolve("."),
    env: env as Record<string, string>,
  });
  try {
    await app.firstWindow();
    const result = await app.evaluate(() => {
      const tls = process.getBuiltinModule("node:tls");
      const { X509Certificate } = process.getBuiltinModule("node:crypto");
      // Node re-serializes PEM text, so compare certificate fingerprints.
      const id = (pem: string) => new X509Certificate(pem).fingerprint256;
      const trusted = new Set(tls.getCACertificates("default").map(id));
      return {
        missing: tls
          .getCACertificates("system")
          .filter((certificate) => !trusted.has(id(certificate))).length,
        bundled: tls
          .getCACertificates("bundled")
          .every((certificate) => trusted.has(id(certificate))),
        childEnv: process.env.NODE_USE_SYSTEM_CA,
      };
    });
    expect(result).toEqual({ missing: 0, bundled: true, childEnv: "1" });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
