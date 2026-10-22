import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  InvocationContext,
  Json,
  OperationInput,
  OperationPlan,
  PolicyDependency,
} from "./types";
const text = z.string().min(1).max(4096);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const resource = z
  .object({
    path: text,
    identity: text,
    ancestors: z
      .array(z.object({ path: text, identity: text }).strict())
      .max(128),
  })
  .strict();
export const effectSchema = z.union([
  z
    .object({
      kind: z.enum([
        "file.read",
        "file.list",
        "file.create",
        "file.modify",
        "file.delete",
      ]),
      target: resource,
    })
    .strict(),
  z
    .object({
      kind: z.literal("network.connect"),
      host: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65535),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["service.read", "service.mutate"]),
      connectionId: text,
      revision: text,
      resource: text,
      action: text,
    })
    .strict(),
  z
    .object({
      kind: z.literal("data.send"),
      receiver: text,
      contentHash: hash,
      bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      kind: z.literal("process.execute"),
      target: z.enum(["vm", "host-srt"]),
      workspaceId: text,
    })
    .strict(),
  z
    .object({
      kind: z.enum(["mcp.start", "mcp.call"]),
      serverId: text,
      generation: text,
      definitionHash: hash,
      argumentsHash: hash,
    })
    .strict(),
]);
const inputSchema = z
  .object({
    tool: z.string().min(1).max(200),
    summary: z.string().max(8000),
    effects: z.array(effectSchema).min(1).max(128),
    connectionRevision: text.optional(),
    executionTarget: z.enum(["trusted-main", "vm", "host-srt"]),
  })
  .strict();
/** Canonical, bounded JSON only. No getters, custom prototypes, cycles or silent JSON coercion. */
export function canonical(value: unknown): string {
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  function visit(v: unknown, depth: number): string {
    if (++nodes > 20000 || depth > 32)
      throw new Error("Operation exceeds JSON limits");
    let out: string;
    if (v === null || typeof v === "boolean") out = JSON.stringify(v);
    else if (typeof v === "number" && Number.isFinite(v))
      out = JSON.stringify(v);
    else if (typeof v === "string") {
      bytes += Buffer.byteLength(v);
      out = JSON.stringify(v);
    } else if (typeof v === "object" && v && !seen.has(v)) {
      if (
        Object.getPrototypeOf(v) !==
        (Array.isArray(v) ? Array.prototype : Object.prototype)
      )
        throw new Error("Unsupported operation value");
      seen.add(v);
      const keys = Object.keys(v);
      if (keys.length > 20000 - nodes || Object.getOwnPropertySymbols(v).length)
        throw new Error("Operation exceeds JSON limits");
      const descriptors = Object.getOwnPropertyDescriptors(v);
      if (Object.values(descriptors).some((d) => d.get || d.set))
        throw new Error("Operation accessors are unsupported");
      if (Array.isArray(v)) {
        if (
          keys.length !== v.length ||
          keys.some((key, i) => key !== String(i)) ||
          Object.getOwnPropertyNames(v).length !== v.length + 1
        )
          throw new Error("Sparse operation array");
        out = "[" + v.map((x) => visit(x, depth + 1)).join(",") + "]";
      } else {
        if (Object.getOwnPropertyNames(v).length !== keys.length)
          throw new Error("Non-enumerable operation value");
        keys.sort();
        out =
          "{" +
          keys
            .map((k) => {
              bytes += Buffer.byteLength(k);
              return (
                JSON.stringify(k) +
                ":" +
                visit((v as Record<string, unknown>)[k], depth + 1)
              );
            })
            .join(",") +
          "}";
      }
      seen.delete(v);
    } else throw new Error("Unsupported operation value");
    if (bytes > 1024 * 1024 || out.length > 2 * 1024 * 1024)
      throw new Error("Operation exceeds JSON limits");
    return out;
  }
  return visit(value, 0);
}
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeJson);
    Object.freeze(value);
  }
  return value;
}
export function operationPlan(
  context: InvocationContext,
  input: OperationInput,
  revision: string,
  expiresAt: number,
  dependencies: readonly PolicyDependency[] = [],
): OperationPlan {
  const copy = JSON.parse(canonical(input)) as OperationInput;
  const { payload, expectedTargets, review, ...rest } = copy;
  inputSchema.parse(rest);
  const body = {
    ...rest,
    payload,
    expectedTargets,
    review,
    policyRevision: revision,
    dependencies,
    expiresAt,
    identity: {
      id: context.id,
      executionId: context.executionId,
      conversationId: context.conversationId,
      runId: context.runId,
      toolCallId: context.toolCallId,
      parentInvocationId: context.parentInvocationId ?? null,
      origin: context.origin,
      epoch: context.epoch,
    },
  };
  return Object.freeze({
    ...freezeJson(copy),
    dependencies: freezeJson(
      JSON.parse(canonical(dependencies)) as PolicyDependency[],
    ),
    id: randomUUID(),
    invocation: context,
    policyRevision: revision,
    payloadHash: fingerprint(payload),
    bindingHash: fingerprint(body),
    expiresAt,
  });
}
export function copyJson<T extends Json>(value: T): T {
  return JSON.parse(canonical(value)) as T;
}
