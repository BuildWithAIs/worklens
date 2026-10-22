import { fingerprint } from "./operation-plan";
import { z } from "zod";
import type { Encryption } from "../storage";
import { SerialQueue } from "../storage";
import { PermissionDocument } from "./store";
import { PermissionError } from "./types";
const auditRecord = z
  .object({
    sequence: z.number().int().nonnegative(),
    time: z.number().int().nonnegative(),
    operationId: z.uuid(),
    conversationId: z.string().max(180),
    runId: z.string().max(180),
    executionId: z.uuid(),
    invocationId: z.uuid(),
    parentToolCallId: z.string().max(180).optional(),
    toolCallId: z.string().max(180),
    parentInvocationId: z.uuid().optional(),
    policyRevision: z.string().max(200),
    target: z.enum(["trusted-main", "vm", "host-srt"]),
    event: z.enum([
      "approved",
      "denied",
      "executing",
      "completed",
      "failed",
      "partial",
      "unknown",
    ]),
    authorization: z.enum(["user", "read-rule", "task", "execution"]),
    effects: z
      .array(
        z.enum([
          "file.read",
          "file.list",
          "file.create",
          "file.modify",
          "file.delete",
          "network.connect",
          "process.execute",
          "service.read",
          "service.mutate",
          "data.send",
          "mcp.start",
          "mcp.call",
        ]),
      )
      .min(1)
      .max(128),
    reviewerEpoch: z.uuid().optional(),
    scope: z.enum(["once", "task"]).optional(),
    origin: z.enum(["agent", "user-ui", "internal"]),
    outcome: z.enum(["not-dispatched", "completed", "unknown"]).optional(),
  })
  .strict();
export type AuditInput = Omit<z.infer<typeof auditRecord>, "sequence" | "time">;
const savedAudit = z
  .object({ version: z.literal(1), records: z.array(auditRecord).max(4096) })
  .strict();
export class AuditService {
  private document: PermissionDocument<z.infer<typeof savedAudit>>;
  private records: z.infer<typeof auditRecord>[] = [];
  private keys = new Set<string>();
  private keyCache = new WeakMap<object, string>();
  private queue = new SerialQueue();
  private ready = false;
  constructor(
    path: string,
    encryption: Encryption,
    private now: () => number = Date.now,
  ) {
    this.document = new PermissionDocument(
      path,
      encryption,
      (value) => savedAudit.parse(value),
      10 * 1024 * 1024,
    );
  }
  load() {
    return this.queue.run("audit", () => this.readDocument());
  }
  private async readDocument() {
    try {
      this.records = (await this.document.read())?.records ?? [];
      this.keys = new Set(this.records.map((record) => this.recordKey(record)));
      this.ready = true;
    } catch {
      this.ready = false;
    }
  }
  get available() {
    return this.ready;
  }
  private recordKey(record: z.infer<typeof auditRecord>) {
    let key = this.keyCache.get(record);
    if (!key) {
      const { sequence: _sequence, time: _time, ...input } = record;
      key = fingerprint(JSON.parse(JSON.stringify(input)));
      this.keyCache.set(record, key);
    }
    return key;
  }
  append(input: AuditInput) {
    return this.queue.run("audit", async () => {
      // Retry through the serialized writer. AtomicJson may have renamed the
      // complete record before a directory-sync error, so reload and deduplicate.
      if (!this.ready) await this.readDocument();
      if (!this.ready)
        throw new PermissionError("PERMISSION_AUDIT_UNAVAILABLE");
      const record = auditRecord.parse({
        ...input,
        sequence: (this.records.at(-1)?.sequence ?? 0) + 1,
        time: this.now(),
      });
      const key = fingerprint(JSON.parse(JSON.stringify(input)));
      const duplicate = this.keys.has(key);
      const next = [
        ...this.records.filter((r) => r.time >= this.now() - 30 * 86400000),
        ...(duplicate ? [] : [record]),
      ].slice(-4096);
      // Bound serialized bytes as well as record count. Leave space for the
      // encrypted/base64 envelope within the 10 MiB on-disk ceiling.
      let bytes = Buffer.byteLength(
        JSON.stringify({ version: 1, records: next }),
      );
      let dropped = 0;
      while (bytes > 4 * 1024 * 1024 && dropped < next.length - 1) {
        bytes -= Buffer.byteLength(JSON.stringify(next[dropped])) + 1;
        dropped++;
      }
      if (dropped) next.splice(0, dropped);
      try {
        await this.document.write({ version: 1, records: next });
      } catch {
        this.ready = false;
        throw new PermissionError("PERMISSION_AUDIT_UNAVAILABLE");
      }
      this.records = next;
      this.keys = new Set(next.map((record) => this.recordKey(record)));
    });
  }
}
