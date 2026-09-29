import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { JevConnections } from "../../../src/main/connectors/jev/connection";
import { JevConsent } from "../../../src/main/connectors/jev/consent";
import { JevService } from "../../../src/main/connectors/jev/service";
import { jevConnector } from "../../../src/main/connectors/jev";
import { ConnectorRegistry } from "../../../src/main/connectors/registry";

const cleanups: (() => Promise<unknown>)[] = [];
export function onCleanup(cleanup: () => Promise<unknown>) {
  cleanups.push(cleanup);
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
import { jevFixture, secret, sample } from "./fixture";
export { secret, sample };
export const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) =>
    Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x73)),
  decryptString: (value: Buffer) =>
    Buffer.from(value.map((byte) => byte ^ 0x73)).toString(),
};
export async function setup(changed?: (id: string) => void) {
  const root = await mkdtemp(join(tmpdir(), "worklens-jev-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const { state, url, close } = await jevFixture();
  cleanups.push(close);
  const connections = new JevConnections(join(root, "jev.json"), crypto);
  const consent = new JevConsent(join(root, "consent.json"), changed, () =>
    connections.consentRevision(),
  );
  const service = new JevService(connections, consent);
  const registry = new ConnectorRegistry([jevConnector(service)]);
  await registry.initialize();
  await connections.save({ url, token: secret });
  const call = (
    args: object = sample,
    sessionId = "session-one",
    name = "jev_classify",
    signal?: AbortSignal,
  ) => {
    const tool = registry
      .tools(sessionId, () => "run")
      .find((tool) => tool.name === name)!;
    return tool.execute("tool-call", args, signal, undefined, {} as any);
  };
  return { root, state, url, connections, consent, service, registry, call };
}
