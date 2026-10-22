import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  PermissionDocument,
  PermissionStore,
} from "../../src/main/permissions/store";
import {
  AuditService,
  type AuditInput,
} from "../../src/main/permissions/audit-service";
import { assertRequestSource } from "../../src/main/ipc-source";
import { directory, encryption, fixture, readRule } from "./helpers";

describe("permission persistence and failure recovery", () => {
  test("retry after a complete write followed by a sync error does not duplicate the record", async () => {
    const f = await fixture();
    const plan = f.prepare();
    const original = PermissionDocument.prototype.write;
    const fault = vi
      .spyOn(PermissionDocument.prototype, "write")
      .mockImplementationOnce(async function (
        this: PermissionDocument<unknown>,
        value,
      ) {
        await original.call(this, value);
        throw new Error("synthetic directory-sync failure");
      });
    try {
      await expect(f.approve(plan)).rejects.toThrow(
        "PERMISSION_AUDIT_UNAVAILABLE",
      );
    } finally {
      fault.mockRestore();
    }
    const envelope = JSON.parse(
      await readFile(join(f.root, "audit.json"), "utf8"),
    );
    const saved = JSON.parse(
      encryption.decryptString(Buffer.from(envelope.encrypted, "base64")),
    );
    const { sequence: _sequence, time: _time, ...record } = saved.records[0];
    await f.audit.append(record);
    const after = JSON.parse(
      await readFile(join(f.root, "audit.json"), "utf8"),
    );
    const records = JSON.parse(
      encryption.decryptString(Buffer.from(after.encrypted, "base64")),
    ).records;
    expect(records).toHaveLength(1);
    expect(records[0].sequence).toBe(1);
    expect(f.audit.available).toBe(true);
  });
  test("encrypts at rest, rejects stale concurrent writes and reloads immutable rules", async () => {
    const root = await directory();
    const path = join(root, "rules.json");
    const store = new PermissionStore(path, encryption);
    await store.load();
    const revision = store.value.revision;
    const rule = readRule();
    const results = await Promise.allSettled([
      store.update(revision, [rule]),
      store.update(revision, [readRule()]),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason.message).toBe(
      "PERMISSION_STALE",
    );
    expect(await readFile(path, "utf8")).not.toContain(rule.path);
    // Windows does not expose POSIX owner/group permission bits through mode.
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    const reloaded = new PermissionStore(path, encryption);
    await reloaded.load();
    expect(reloaded.value.rules).toEqual([rule]);
    expect(Object.isFrozen(reloaded.value.rules[0])).toBe(true);
  });
  test.each(["invalid-json", "wrong-cipher", "symlink"])(
    "%s leaves the original document intact and closes permission operations",
    async (failure) => {
      const root = await directory();
      const path = join(root, "rules.json");
      const source = join(root, "source.json");
      if (failure === "symlink") {
        await writeFile(source, "untouched");
        await symlink(source, path);
      } else
        await writeFile(
          path,
          failure === "invalid-json"
            ? "damaged-json"
            : JSON.stringify({
                version: 1,
                encrypted: Buffer.from("wrong-key").toString("base64"),
              }),
        );
      const original = await readFile(path, "utf8");
      const store = new PermissionStore(path, encryption);
      await store.load();
      expect(store.available).toBe(false);
      await expect(
        store.update(store.value.revision, [readRule()]),
      ).rejects.toThrow("PERMISSION_STORE_UNAVAILABLE");
      expect(await readFile(path, "utf8")).toBe(original);
    },
  );
  test("unavailable OS encryption is reported even on a fresh install", async () => {
    const root = await directory();
    const unavailable = { ...encryption, isEncryptionAvailable: () => false };
    const store = new PermissionStore(join(root, "rules.json"), unavailable);
    const audit = new AuditService(join(root, "audit.json"), unavailable);
    await Promise.all([store.load(), audit.load()]);
    expect(store.available).toBe(false);
    expect(audit.available).toBe(false);
  });
  test("a real persistence failure disables new approvals instead of publishing unsaved rules", async () => {
    const root = await directory();
    const path = join(root, "rules.json");
    const store = new PermissionStore(path, encryption);
    await store.load();
    await mkdir(path);
    await expect(
      store.update(store.value.revision, [readRule()]),
    ).rejects.toThrow("PERMISSION_STORE_UNAVAILABLE");
    expect(store.available).toBe(false);
    expect(store.value.rules).toEqual([]);
    const f = await fixture();
    const plan = f.prepare();
    await mkdir(join(f.root, "audit.json"));
    await expect(f.approve(plan)).rejects.toThrow(
      "PERMISSION_AUDIT_UNAVAILABLE",
    );
    expect(f.service.snapshot("conversation-a").grants).toEqual([]);
    expect(f.service.snapshot("conversation-a").error).toBe(
      "PERMISSION_AUDIT_UNAVAILABLE",
    );
    await rm(join(f.root, "audit.json"), { recursive: true });
    await expect(f.approve(f.prepare())).resolves.toBeDefined();
    expect(f.audit.available).toBe(true);
  });
  test("document reads are bounded and oversized documents stay intact", async () => {
    const root = await directory();
    const path = join(root, "bounded.json");
    const data = "x".repeat(1025);
    await writeFile(path, data);
    await expect(
      new PermissionDocument(path, encryption, (value) => value, 1024).read(),
    ).rejects.toThrow("Invalid permission document");
    expect(await readFile(path, "utf8")).toBe(data);
  });
  test("audit expiration retains sequence and does not delete unrelated files", async () => {
    const root = await directory();
    const path = join(root, "audit.json");
    let clock = 1_800_000_000_000;
    await writeFile(
      join(root, "unrelated-journal.json"),
      "synthetic unrelated state",
    );
    const audit = new AuditService(path, encryption, () => clock);
    await audit.load();
    const record: AuditInput = {
      operationId: randomUUID(),
      conversationId: "conversation-a",
      runId: "run-a",
      executionId: randomUUID(),
      invocationId: randomUUID(),
      toolCallId: "call-a",
      policyRevision: "revision-a",
      target: "vm",
      event: "executing",
      origin: "agent",
      authorization: "user",
      effects: ["network.connect"],
    };
    await audit.append(record);
    clock += 31 * 86400000;
    await audit.append({ ...record, event: "unknown" });
    const outer = JSON.parse(await readFile(path, "utf8"));
    const saved = JSON.parse(
      encryption.decryptString(Buffer.from(outer.encrypted, "base64")),
    );
    expect(saved.records).toHaveLength(1);
    expect(saved.records[0]).toMatchObject({ sequence: 2, event: "unknown" });
    expect(await readFile(join(root, "unrelated-journal.json"), "utf8")).toBe(
      "synthetic unrelated state",
    );
  });
  test("large audit histories rotate by bytes before exhausting the encrypted document limit", async () => {
    const root = await directory();
    const path = join(root, "audit.json");
    const clock = 1_800_000_000_000;
    const record: AuditInput = {
      operationId: randomUUID(),
      conversationId: "conversation-a",
      runId: "run-a",
      executionId: randomUUID(),
      invocationId: randomUUID(),
      toolCallId: "call-a",
      policyRevision: "revision-a",
      target: "trusted-main",
      event: "executing",
      origin: "agent",
      authorization: "user",
      effects: Array(48).fill("network.connect"),
    };
    const seed = {
      version: 1,
      records: Array.from({ length: 4096 }, (_, i) => ({
        ...record,
        sequence: i + 1,
        time: clock,
      })),
    };
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        encrypted: encryption
          .encryptString(JSON.stringify(seed))
          .toString("base64"),
      }),
    );
    const audit = new AuditService(path, encryption, () => clock);
    await audit.load();
    expect(audit.available).toBe(true);
    await audit.append({ ...record, event: "completed" });
    const outer = JSON.parse(await readFile(path, "utf8"));
    const saved = JSON.parse(
      encryption.decryptString(Buffer.from(outer.encrypted, "base64")),
    );
    expect(saved.records.length).toBeLessThan(4096);
    expect(saved.records.at(-1)).toMatchObject({
      sequence: 4097,
      event: "completed",
    });
    expect((await stat(path)).size).toBeLessThan(10 * 1024 * 1024);
    expect(audit.available).toBe(true);
  });
});

describe("IPC provenance boundary shared by existing and permission requests", () => {
  test("only the current main window and its main frame may invoke handlers", () => {
    const frame = {};
    const webContents = { mainFrame: frame };
    const window = { webContents };
    expect(() =>
      assertRequestSource(window, { sender: webContents, senderFrame: frame }),
    ).not.toThrow();
    for (const [candidate, sender, senderFrame] of [
      [undefined, webContents, frame],
      [window, { mainFrame: frame }, frame],
      [window, webContents, {}],
      [window, webContents, undefined],
    ] as const)
      expect(() =>
        assertRequestSource(candidate, { sender, senderFrame }),
      ).toThrow("不受信任的调用来源");
  });
});
