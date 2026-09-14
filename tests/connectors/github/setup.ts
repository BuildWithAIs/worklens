import {
  randomUUID,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { GitHubConnections } from "../../../src/main/connectors/github/connection";
import { GitHubService } from "../../../src/main/connectors/github/service";
import { LocalArtifacts } from "../../../src/main/local-artifacts";
import { githubFixture } from "./fixture";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
export function encryption() {
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
export async function setup(
  fetchOverride?: (base: typeof fetch) => typeof fetch,
) {
  const root = await mkdtemp(join(tmpdir(), "worklens-github-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fixture = await githubFixture();
  cleanups.push(fixture.close);
  const crypto = encryption();
  const fetcher = fetchOverride ? fetchOverride(fetch) : fetch;
  const connections = new GitHubConnections(
    join(root, "github.json"),
    crypto,
    fetcher,
  );
  const input = { url: fixture.url, token: "synthetic-github-secret" };
  await connections.save(input);
  const artifacts = new LocalArtifacts(join(root, "artifacts"), root);
  const service = new GitHubService(connections, artifacts);
  let run = "run1";
  const call = async (
    request: object,
    write = false,
    session = "session1",
    signal = new AbortController().signal,
    callId: string = randomUUID(),
  ) => {
    const result = await service
      .tools(session, () => run)
      [
        write ? 1 : 0
      ].execute(callId, { request }, signal, undefined, {} as any);
    return {
      result,
      data: JSON.parse((result.content[0] as { text: string }).text),
    };
  };
  return {
    root,
    fixture,
    crypto,
    connections,
    input,
    artifacts,
    service,
    call,
    nextRun: () => {
      run += "x";
    },
  };
}
