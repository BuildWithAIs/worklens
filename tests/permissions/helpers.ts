import { confirmedResult } from "../../src/main/permissions/execution-contract";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  ApprovalService,
  type CurrentOperation,
} from "../../src/main/permissions/approval-service";
import { AuditService } from "../../src/main/permissions/audit-service";
import { PermissionStore } from "../../src/main/permissions/store";
import type {
  OperationInput,
  OperationPlan,
  PolicySettings,
  ReadRule,
  Json,
} from "../../src/main/permissions/types";
import type { PermissionEvent } from "../../src/shared/permissions";

// Deliberately synthetic test cipher. Production uses Electron safeStorage.
export const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) =>
    Buffer.from(Buffer.from(text).map((b) => b ^ 0x79)),
  decryptString: (data: Buffer) =>
    Buffer.from(data.map((b) => b ^ 0x79)).toString(),
};
const cleanup: (() => Promise<unknown> | void)[] = [];
export function disposeWith(fn: () => Promise<unknown> | void) {
  cleanup.push(fn);
}
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
export async function directory() {
  const path = await mkdtemp(join(tmpdir(), "worklens-permission-test-"));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export function readRule(overrides: Partial<ReadRule> = {}): ReadRule {
  return {
    id: randomUUID(),
    conversationId: "conversation-a",
    path: "/synthetic/project",
    identity: "volume-a:node-7",
    subtree: true,
    actions: ["file.read", "file.list"],
    enabled: true,
    ...overrides,
  };
}
export function input(overrides: Partial<OperationInput> = {}): OperationInput {
  return {
    tool: "controlled-http",
    summary: "Connect to the selected test service",
    review: { receiver: "example.test", port: 443 },
    payload: { url: "https://example.test/item", body: "invented content" },
    effects: [{ kind: "network.connect", host: "example.test", port: 443 }],
    expectedTargets: { destination: "test-service-v1" },
    executionTarget: "trusted-main",
    ...overrides,
  };
}
export async function fixture(
  options: { rules?: ReadRule[]; policy?: Partial<PolicySettings> } = {},
) {
  const root = await directory();
  const store = new PermissionStore(join(root, "rules.json"), encryption);
  const audit = new AuditService(
    join(root, "audit.json"),
    encryption,
    () => clock,
  );
  let clock = 1_800_000_000_000;
  await store.load();
  if (options.rules) await store.update(store.value.revision, options.rules);
  const events: PermissionEvent[] = [];
  const service = new ApprovalService(store, audit, {
    now: () => clock,
    emit: (event) => events.push(event),
    redact: (text) => text.replaceAll("synthetic-private-value", "[redacted]"),
    policy: () => ({
      protectedPaths: ["/synthetic/control"],
      deniedPaths: [],
      fileBoundary: true,
      backends: { vm: true, hostSrt: true },
      ...options.policy,
    }),
  });
  await service.initialize();
  const owner = Object.freeze({ window: "synthetic-main" });
  service.attachReviewer(owner);
  service.beginTask("conversation-a", "run-a");
  cleanup.push(() => service.close());
  const prepare = (
    overrides: Partial<OperationInput> = {},
    conversation = "conversation-a",
    run = "run-a",
  ) =>
    service.prepare(
      service.contexts.create(conversation, run, randomUUID(), "agent"),
      input(overrides),
    );
  const approve = (plan: OperationPlan, scope: "once" | "task" = "once") =>
    service.reply(
      {
        conversationId: plan.invocation.conversationId,
        requestId: plan.id,
        decision: "allow",
        scope,
      },
      owner,
    );
  const validate = async (plan: OperationPlan): Promise<CurrentOperation> => ({
    payloadHash: plan.payloadHash,
    expectedTargets: plan.expectedTargets,
    executionTarget: plan.executionTarget,
    ...(plan.connectionRevision
      ? { connectionRevision: plan.connectionRevision }
      : {}),
  });
  return {
    root,
    store,
    audit,
    service,
    owner,
    events,
    prepare,
    approve,
    validate,
    execute: <T>(
      plan: OperationPlan,
      check: (plan: OperationPlan) => Promise<CurrentOperation>,
      effect: (payload: Json, signal: AbortSignal) => Promise<T>,
    ) =>
      service.execute(plan, check, async (payload, signal) =>
        confirmedResult(await effect(payload, signal)),
      ),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
