import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { ConfluenceConnections } from "../src/main/confluence/connection";
import { ConfluenceService } from "../src/main/confluence/service";
import { LocalArtifacts } from "../src/main/local-artifacts";
import { confluenceFixture } from "./confluence-fixture";
export const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
export function testEncryption() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(value: Buffer) {
      const cipher = createDecipheriv(
        "aes-256-gcm",
        key,
        value.subarray(0, 12),
      );
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([
        cipher.update(value.subarray(28)),
        cipher.final(),
      ]).toString();
    },
  };
}
export async function setup() {
  const root = await mkdtemp(join(tmpdir(), "worklens-confluence-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fixture = await confluenceFixture();
  cleanups.push(fixture.close);
  const encryption = testEncryption();
  const connections = new ConfluenceConnections(
    join(root, "connection.json"),
    encryption,
  );
  const input = {
    url: fixture.url,
    deployment: "data-center" as const,
    tokenType: "classic" as const,
    token: "synthetic-secret-123",
  };
  await connections.save(input);
  const artifacts = new LocalArtifacts(join(root, "artifacts"), root);
  const service = new ConfluenceService(connections, artifacts);
  let run = "run1";
  const tools = service.tools("session1", () => run);
  const call = async (
    request: object,
    write = false,
    signal = new AbortController().signal,
  ) => {
    const result = await tools[write ? 1 : 0].execute(
      "tool1",
      { request },
      signal,
      undefined,
      {} as any,
    );
    return {
      result: result as typeof result & { isError?: boolean },
      data: JSON.parse((result.content[0] as { text: string }).text),
    };
  };
  return {
    root,
    fixture,
    connections,
    encryption,
    input,
    artifacts,
    service,
    call,
    nextRun: () => {
      run += "x";
    },
  };
}
