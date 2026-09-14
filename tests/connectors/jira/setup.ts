import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { JiraConnections } from "../../../src/main/connectors/jira/connection";
import { JiraService } from "../../../src/main/connectors/jira/service";
import { LocalArtifacts } from "../../../src/main/local-artifacts";
import { jiraFixture } from "./fixture";
const cleanups: (() => Promise<unknown>)[] = [];
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
export async function setup(cloud = false, scoped = false) {
  const root = await mkdtemp(join(tmpdir(), "worklens-jira-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fixture = await jiraFixture();
  cleanups.push(fixture.close);
  const encryption = testEncryption();
  const fetcher: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    if (target.pathname === "/_edge/tenant_info")
      return Response.json({ cloudId: "cloud-123" });
    if (
      target.hostname === "fixture.atlassian.net" ||
      target.hostname === "api.atlassian.com"
    )
      return fetch(
        fixture.url +
          target.pathname.replace(/^\/ex\/jira\/cloud-123/, "") +
          target.search,
        init,
      );
    return fetch(url, init);
  };
  const input = {
    url: cloud ? "https://fixture.atlassian.net" : fixture.url,
    deployment: cloud ? ("cloud" as const) : ("data-center" as const),
    tokenType: scoped ? ("scoped" as const) : ("classic" as const),
    ...(cloud
      ? {
          email: "fixture@example.com",
          ...(scoped ? { cloudId: "cloud-123" } : {}),
        }
      : {}),
    token: "synthetic-jira-secret",
  };
  const connections = new JiraConnections(
    join(root, "jira.json"),
    encryption,
    fetcher,
  );
  await connections.save(input);
  const artifacts = new LocalArtifacts(join(root, "artifacts"), root);
  const service = new JiraService(connections, artifacts, fetcher);
  let run = "run1";
  const call = async (
    request: object,
    write = false,
    session = "session1",
    signal = new AbortController().signal,
  ) => {
    const result = await service
      .tools(session, () => run)
      [
        write ? 1 : 0
      ].execute("call", { request }, signal, undefined, {} as any);
    return {
      result,
      data: JSON.parse((result.content[0] as { text: string }).text),
    };
  };
  return {
    root,
    fixture,
    encryption,
    input,
    connections,
    artifacts,
    service,
    fetcher,
    call,
    nextRun: () => {
      run += "x";
    },
  };
}
