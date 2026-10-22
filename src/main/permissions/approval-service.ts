import { randomUUID } from "node:crypto";
import { redactStrings } from "../storage";
import type {
  PermissionApprovalView,
  PermissionEvent,
  PermissionExecutionTarget,
  PermissionRequests,
  PermissionScope,
  PermissionSnapshot,
  PermissionState,
} from "../../shared/permissions";
import { InvocationContexts } from "./invocation-context";
import { fingerprint, operationPlan } from "./operation-plan";
import { permissionSchemas } from "./validation";
import { PolicyService, atOrUnder, networkHost } from "./policy-service";
import { PermissionStore } from "./store";
import { AuditService, type AuditInput } from "./audit-service";
import {
  assertExecutionBoundary,
  isConfirmedResult,
  type ConfirmedResult,
  type ExecutionBoundary,
} from "./execution-contract";
import {
  PermissionError,
  type InvocationContext,
  type Json,
  type OperationInput,
  type OperationPlan,
  type PolicyDependency,
  type PolicySettings,
  type ReadRule,
} from "./types";
interface Grant {
  id: string;
  version: string;
  runId: string;
  operationId: string;
  kind: "operation" | "execution";
  scope: PermissionScope;
  effectsHash: string;
  expiresAt?: number;
  revoked: boolean;
  network: { host: string; port: number }[];
  boundary?: ExecutionBoundary;
}
interface Entry {
  plan: OperationPlan;
  state: PermissionState;
  scopes: PermissionScope[];
  controller: AbortController;
  grant?: Grant;
  approvalRef: PolicyDependency;
  replying?: { epoch: string };
  dispatched: boolean;
  timer?: NodeJS.Timeout;
  auditPending?: boolean;
  authorization: AuditInput["authorization"];
  waiter?: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  };
}
export interface CurrentOperation {
  payloadHash: string;
  expectedTargets: Json;
  connectionRevision?: string;
  executionTarget: PermissionExecutionTarget;
}
export interface RevocationEvent {
  conversationId: string;
  runId: string;
  grantId: string;
  kind: "operation" | "execution";
  target?: "vm" | "host-srt";
  network: { host: string; port: number }[];
}
interface Options {
  now?: () => number;
  emit?: (event: PermissionEvent) => void;
  redact?: (value: string) => string;
  policy?: () => Omit<PolicySettings, "readRules" | "execution">;
  /** P3 must observe this event and confirm actual host termination. Aborting is not proof of termination. */
  onRevoke?: (event: RevocationEvent) => void;
}
const active = (e: Entry) =>
  ["awaiting_approval", "approved", "reserved", "executing"].includes(e.state);
export class ApprovalService {
  readonly contexts = new InvocationContexts();
  private policy = new PolicyService();
  private entries = new Map<string, Entry>();
  private grants = new Map<string, Map<string, Grant>>();
  private revisions = new Map<string, string>();
  private updatingRules = new Set<string>();
  private owner?: object;
  private reviewerEpoch = randomUUID();
  private eventSequence = 0;
  private now: () => number;
  private closed = false;
  private pendingAudit = new Map<
    string,
    { entry: Entry; record: AuditInput }
  >();
  private retryTimer?: NodeJS.Timeout;
  constructor(
    private store: PermissionStore,
    private audit: AuditService,
    private options: Options = {},
  ) {
    this.now = options.now ?? Date.now;
  }
  async initialize() {
    await Promise.all([this.store.load(), this.audit.load()]);
  }
  attachReviewer(identity?: object) {
    if (identity === this.owner) return;
    this.owner = identity;
    this.reviewerEpoch = randomUUID();
    for (const e of this.entries.values())
      if (e.state === "awaiting_approval") e.replying = undefined;
    // A document's lifecycle is not the task's lifecycle. Keep pending plans.
    for (const id of this.revisions.keys()) this.changed(id);
  }
  beginTask(conversationId: string, runId: string) {
    if (this.closed) return;
    this.endTask(conversationId);
    this.contexts.begin(conversationId, runId);
    this.revisions.set(conversationId, randomUUID());
    this.changed(conversationId);
  }
  endTask(conversationId: string, runId?: string) {
    const current = this.contexts.current(conversationId);
    if (!current || (runId && runId !== current.runId)) return;
    for (const entry of this.entries.values())
      if (
        entry.plan.invocation.conversationId === conversationId &&
        entry.plan.invocation.runId === current.runId &&
        !entry.dispatched &&
        active(entry)
      )
        this.invalidateEntry(entry, "cancelled");
    for (const g of this.grants.get(conversationId)?.values() ?? [])
      g.revoked = true;
    this.grants.delete(conversationId);
    this.contexts.end(conversationId, runId);
    this.revisions.delete(conversationId);
    this.changed(conversationId, undefined, current.runId);
  }
  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    for (const id of this.revisions.keys()) this.endTask(id);
    this.contexts.close();
    this.owner = undefined;
  }
  private changed(
    conversationId: string,
    entry?: Entry,
    runId = entry?.plan.invocation.runId ??
      this.contexts.current(conversationId)?.runId,
  ) {
    if (entry?.waiter && entry.state !== "awaiting_approval") {
      const waiter = entry.waiter;
      entry.waiter = undefined;
      if (entry.state === "approved") waiter.resolve();
      else
        waiter.reject(
          new PermissionError(
            entry.state === "rejected"
              ? "PERMISSION_DENIED"
              : entry.state === "expired"
                ? "PERMISSION_EXPIRED"
                : "PERMISSION_STALE",
          ),
        );
    }
    const revision =
      entry && this.contexts.current(conversationId)?.runId !== runId
        ? entry.plan.policyRevision
        : this.revision(conversationId);
    const event: PermissionEvent = {
      sequence: ++this.eventSequence,
      conversationId,
      ...(runId ? { runId } : {}),
      revision,
      ...(entry
        ? {
            operationId: entry.plan.id,
            state: entry.state,
            ...(entry.auditPending ? { auditPending: true } : {}),
          }
        : {}),
    };
    try {
      this.options.emit?.(event);
    } catch {
      /* Delivery cannot change an authorization or outcome. */
    }
  }
  private revision(id: string) {
    const rules = this.store.value.rules
      .filter((rule) => rule.conversationId === id)
      .map((rule) => ({ id: rule.id, version: fingerprint(rule) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return `${this.revisions.get(id) ?? "inactive"}:${fingerprint(rules)}`;
  }
  private touch(id: string) {
    if (this.revisions.has(id)) this.revisions.set(id, randomUUID());
  }
  private settings(context: InvocationContext): PolicySettings {
    const binding = [
      ...(this.grants.get(context.conversationId)?.values() ?? []),
    ].find(
      (g) => g.kind === "execution" && g.runId === context.runId && !g.revoked,
    );
    let boundary = binding?.boundary;
    if (boundary) {
      try {
        assertExecutionBoundary(boundary);
      } catch {
        boundary = undefined;
      }
    }
    return {
      ...(this.options.policy?.() ?? {
        protectedPaths: [],
        deniedPaths: [],
        fileBoundary: false,
        backends: { vm: false, hostSrt: false },
      }),
      readRules: this.store.value.rules.filter(
        (r) => !this.updatingRules.has(r.id),
      ),
      execution:
        boundary && binding
          ? {
              conversationId: context.conversationId,
              runId: context.runId,
              target: boundary.target,
              workspaceId: boundary.workspaceId,
              revision: binding.version,
              grantId: binding.id,
            }
          : undefined,
    };
  }
  private ready() {
    if (this.closed) throw new PermissionError("PERMISSION_STALE");
    if (!this.store.available)
      throw new PermissionError("PERMISSION_STORE_UNAVAILABLE");
    if (this.pendingAudit.size >= 512)
      throw new PermissionError("PERMISSION_CAPACITY_EXCEEDED");
  }
  private requireReviewer(owner: object) {
    if (!this.owner || owner !== this.owner)
      throw new PermissionError("PERMISSION_DENIED");
  }
  private lookup(plan: OperationPlan) {
    const e = this.entries.get(plan.id);
    if (!e || e.plan !== plan) throw new PermissionError("PERMISSION_STALE");
    return e;
  }
  private validGrant(grant: Grant | undefined, context: InvocationContext) {
    return (
      !!grant &&
      !grant.revoked &&
      grant.runId === context.runId &&
      (grant.expiresAt === undefined || grant.expiresAt > this.now())
    );
  }
  private live(entry: Entry) {
    this.ready();
    this.contexts.assert(entry.plan.invocation);
    if (!active(entry)) throw new PermissionError("PERMISSION_STALE");
    if (this.now() >= entry.plan.expiresAt)
      throw new PermissionError("PERMISSION_EXPIRED");
    for (const dep of entry.plan.dependencies) {
      if (dep.kind === "rule") {
        const rule = this.store.value.rules.find((r) => r.id === dep.id);
        if (
          !rule ||
          this.updatingRules.has(dep.id) ||
          fingerprint(rule) !== dep.version
        )
          throw new PermissionError("PERMISSION_STALE");
      } else if (
        dep.id !== entry.approvalRef.id ||
        entry.state !== "awaiting_approval"
      ) {
        const grant =
          entry.grant?.id === dep.id
            ? entry.grant
            : this.grants
                .get(entry.plan.invocation.conversationId)
                ?.get(dep.id);
        if (
          !this.validGrant(grant, entry.plan.invocation) ||
          grant!.version !== dep.version
        )
          throw new PermissionError("PERMISSION_STALE");
      }
    }
    const decision = this.policy.evaluate(
      entry.plan,
      this.settings(entry.plan.invocation),
    );
    if (decision.kind === "deny") throw new PermissionError(decision.code);
  }
  private invalidateEntry(
    entry: Entry,
    state: "cancelled" | "invalidated" | "expired" = "invalidated",
  ) {
    if (entry.dispatched || !active(entry)) return;
    entry.state = state;
    clearTimeout(entry.timer);
    entry.controller.abort();
    this.changed(entry.plan.invocation.conversationId, entry);
  }
  private grantHash(
    input: Pick<
      OperationPlan,
      "effects" | "tool" | "executionTarget" | "connectionRevision"
    >,
  ) {
    return fingerprint({
      effects: input.effects,
      tool: input.tool,
      executionTarget: input.executionTarget,
      connectionRevision: input.connectionRevision ?? null,
    });
  }
  private ruleMatches(
    rule: ReadRule,
    effect: OperationInput["effects"][number],
    context: InvocationContext,
  ) {
    if (effect.kind !== "file.read" && effect.kind !== "file.list")
      return false;
    return (
      rule.enabled &&
      rule.conversationId === context.conversationId &&
      rule.actions.includes(effect.kind) &&
      (rule.subtree
        ? atOrUnder(effect.target.path, rule.path) &&
          (effect.target.path === rule.path
            ? effect.target.identity === rule.identity
            : effect.target.ancestors.some(
                (a) => a.path === rule.path && a.identity === rule.identity,
              ))
        : effect.target.path === rule.path &&
          effect.target.identity === rule.identity)
    );
  }
  prepare(context: InvocationContext, input: OperationInput): OperationPlan {
    this.ready();
    this.contexts.assert(context);
    for (const [id, e] of this.entries)
      if (!active(e) && !e.auditPending) {
        clearTimeout(e.timer);
        this.entries.delete(id);
      }
    if (this.entries.size >= 512)
      throw new PermissionError("PERMISSION_CAPACITY_EXCEEDED");
    // Normalize before inspecting effects; no accessors or mutable input reach policy decisions.
    const draft = operationPlan(
      context,
      input,
      this.revision(context.conversationId),
      this.now() + 600000,
    );
    const settings = this.settings(context);
    const decision = this.policy.evaluate(draft, settings);
    if (decision.kind === "deny") throw new PermissionError(decision.code);
    const prior = [
      ...(this.grants.get(context.conversationId)?.values() ?? []),
    ].find(
      (g) =>
        g.kind === "operation" &&
        g.scope === "task" &&
        this.validGrant(g, context) &&
        g.effectsHash === this.grantHash(draft),
    );
    const approvalRef: PolicyDependency = {
      kind: "grant",
      id: prior?.id ?? randomUUID(),
      version: prior?.version ?? randomUUID(),
    };
    const dependencies: PolicyDependency[] = [];
    for (const effect of draft.effects) {
      const rule = settings.readRules.find((r) =>
        this.ruleMatches(r, effect, context),
      );
      if (rule && !dependencies.some((d) => d.id === rule.id))
        dependencies.push({
          kind: "rule",
          id: rule.id,
          version: fingerprint(rule),
        });
      if (
        effect.kind === "process.execute" &&
        settings.execution &&
        !dependencies.some((d) => d.id === settings.execution!.grantId)
      )
        dependencies.push({
          kind: "execution",
          id: settings.execution.grantId,
          version: settings.execution.revision,
        });
    }
    dependencies.push(approvalRef);
    const plan = operationPlan(
      context,
      input,
      draft.policyRevision,
      draft.expiresAt,
      dependencies,
    );
    const auto = decision.kind === "allow" || !!prior;
    const entry: Entry = {
      plan,
      state: auto ? "approved" : "awaiting_approval",
      scopes: decision.kind === "ask" ? decision.scopes : ["once"],
      controller: new AbortController(),
      dispatched: false,
      approvalRef,
      authorization: prior
        ? "task"
        : auto
          ? draft.effects.some((effect) => effect.kind === "process.execute")
            ? "execution"
            : "read-rule"
          : "user",
    };
    if (auto) entry.grant = prior ?? this.newGrant(entry, "once");
    entry.timer = setTimeout(
      () => this.invalidateEntry(entry, "expired"),
      Math.max(1, plan.expiresAt - this.now()),
    );
    entry.timer.unref();
    this.entries.set(plan.id, entry);
    this.changed(context.conversationId, entry);
    return plan;
  }
  private newGrant(entry: Entry, scope: PermissionScope): Grant {
    return {
      id: entry.approvalRef.id,
      version: entry.approvalRef.version,
      runId: entry.plan.invocation.runId,
      operationId: entry.plan.id,
      kind: "operation",
      scope,
      effectsHash: this.grantHash(entry.plan),
      ...(scope === "once" ? { expiresAt: entry.plan.expiresAt } : {}),
      revoked: false,
      network: entry.plan.effects
        .filter(
          (e): e is Extract<typeof e, { kind: "network.connect" }> =>
            e.kind === "network.connect",
        )
        .map((e) => ({ host: e.host, port: e.port })),
    };
  }
  async waitForApproval(plan: OperationPlan): Promise<void> {
    const e = this.lookup(plan);
    this.live(e);
    if (e.state === "approved") return;
    if (e.state !== "awaiting_approval")
      throw new PermissionError("PERMISSION_STALE");
    if (!e.waiter) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      e.waiter = { promise, resolve, reject };
    }
    await e.waiter.promise;
    this.live(e);
  }
  private view(e: Entry): PermissionApprovalView {
    const p = e.plan;
    return {
      id: p.id,
      operationId: p.id,
      conversationId: p.invocation.conversationId,
      runId: p.invocation.runId,
      toolCallId: p.invocation.toolCallId,
      tool: p.tool,
      details: redactStrings(p.review, this.options.redact ?? ((v) => v)),
      summary: (this.options.redact?.(p.summary) ?? p.summary).slice(0, 8000),
      payloadHash: p.payloadHash,
      policyRevision: p.policyRevision,
      executionTarget: p.executionTarget,
      expiresAt: p.expiresAt,
      scopes: [...e.scopes],
      state: e.state,
    };
  }
  snapshot(conversationId: string): PermissionSnapshot {
    const current = this.contexts.current(conversationId);
    const entries = [...this.entries.values()].filter(
      (e) =>
        e.plan.invocation.conversationId === conversationId &&
        e.plan.invocation.runId === current?.runId,
    );
    const grants = new Map<string, Grant>();
    for (const g of this.grants.get(conversationId)?.values() ?? [])
      if (
        !g.revoked &&
        g.runId === current?.runId &&
        (g.expiresAt === undefined || g.expiresAt > this.now())
      )
        grants.set(g.id, g);
    for (const e of entries)
      if (e.grant && this.validGrant(e.grant, e.plan.invocation) && active(e))
        grants.set(e.grant.id, e.grant);
    return {
      conversationId,
      ...(current ? { runId: current.runId } : {}),
      revision: this.revision(conversationId),
      enforcement: "not-connected",
      backends: { vm: false, hostSrt: false, fileBoundary: false },
      ...(!this.store.available
        ? { error: "PERMISSION_STORE_UNAVAILABLE" as const }
        : !this.audit.available
          ? { error: "PERMISSION_AUDIT_UNAVAILABLE" as const }
          : {}),
      pending: entries
        .filter(
          (e) =>
            e.state === "awaiting_approval" && e.plan.expiresAt > this.now(),
        )
        .map((e) => this.view(e)),
      grants: [...grants.values()].map(
        ({ id, scope, operationId, expiresAt, runId, kind }) => ({
          id,
          scope,
          operationId,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          runId,
          kind,
        }),
      ),
      rules: this.store.value.rules
        .filter((r) => r.conversationId === conversationId)
        .map((r) => ({ id: r.id, enabled: r.enabled })),
    };
  }
  private auditInput(e: Entry, event: AuditInput["event"]): AuditInput {
    const p = e.plan,
      c = p.invocation;
    return {
      operationId: p.id,
      conversationId: c.conversationId,
      runId: c.runId,
      executionId: c.executionId,
      invocationId: c.id,
      toolCallId: c.toolCallId,
      ...(c.parentInvocationId
        ? {
            parentInvocationId: c.parentInvocationId,
            parentToolCallId: c.parentToolCallId,
          }
        : {}),
      authorization: e.authorization,
      effects: p.effects.map((e) => e.kind),
      policyRevision: p.policyRevision,
      target: p.executionTarget,
      origin: c.origin,
      event,
      ...(event === "completed"
        ? { outcome: "completed" as const }
        : event === "unknown"
          ? { outcome: "unknown" as const }
          : event === "failed"
            ? { outcome: "not-dispatched" as const }
            : {}),
    };
  }
  async reply(
    input: PermissionRequests["permissionReply"]["input"],
    owner: object,
  ) {
    input = permissionSchemas.permissionReply.parse(input);
    this.requireReviewer(owner);
    const epoch = this.reviewerEpoch;
    const e = this.entries.get(input.requestId);
    if (
      !e ||
      e.plan.invocation.conversationId !== input.conversationId ||
      e.state !== "awaiting_approval" ||
      e.replying
    )
      throw new PermissionError("PERMISSION_STALE");
    this.live(e);
    if (!e.scopes.includes(input.scope))
      throw new PermissionError("PERMISSION_DENIED");
    const reservation = { epoch };
    e.replying = reservation;
    try {
      await this.audit.append({
        ...this.auditInput(
          e,
          input.decision === "allow" ? "approved" : "denied",
        ),
        reviewerEpoch: epoch,
        scope: input.scope,
      });
      this.requireReviewer(owner);
      if (epoch !== this.reviewerEpoch || e.replying !== reservation)
        throw new PermissionError("PERMISSION_DENIED");
      this.live(e);
      if (input.decision === "deny") e.state = "rejected";
      else {
        e.grant = this.newGrant(e, input.scope);
        if (input.scope === "task")
          this.grantMap(input.conversationId).set(e.grant.id, e.grant);
        e.state = "approved";
      }
      this.changed(input.conversationId, e);
      return this.snapshot(input.conversationId);
    } catch (error) {
      // Old document replies do not invalidate the pending request owned by its successor.
      if (
        epoch === this.reviewerEpoch &&
        this.owner === owner &&
        e.replying === reservation
      )
        this.invalidateEntry(e);
      throw error;
    } finally {
      if (e.replying === reservation) e.replying = undefined;
    }
  }
  private grantMap(id: string) {
    let map = this.grants.get(id);
    if (!map) {
      map = new Map();
      this.grants.set(id, map);
    }
    return map;
  }
  authorizeExecution(
    context: InvocationContext,
    boundary: ExecutionBoundary,
    owner?: object,
  ): string {
    this.ready();
    this.contexts.assert(context);
    assertExecutionBoundary(boundary);
    if (
      boundary.conversationId !== context.conversationId ||
      boundary.runId !== context.runId
    )
      throw new PermissionError("PERMISSION_DENIED");
    if (boundary.target === "host-srt") {
      if (!owner) throw new PermissionError("PERMISSION_DENIED");
      this.requireReviewer(owner);
    }
    const settings = this.settings(context);
    if (
      !(boundary.target === "vm"
        ? settings.backends.vm
        : settings.backends.hostSrt)
    )
      throw new PermissionError("CAPABILITY_UNSUPPORTED");
    const map = this.grantMap(context.conversationId);
    for (const g of map.values())
      if (g.kind === "execution" && !g.revoked)
        this.revokeGrant(context.conversationId, g);
    const g: Grant = {
      id: randomUUID(),
      version: randomUUID(),
      runId: context.runId,
      operationId: context.executionId,
      kind: "execution",
      scope: "task",
      effectsHash: "",
      revoked: false,
      boundary,
      network: [],
    };
    map.set(g.id, g);
    this.touch(context.conversationId);
    this.changed(context.conversationId);
    return g.id;
  }
  /** Called for EVERY new proxy connection, including from an already-running script. */
  networkAllowed(
    context: InvocationContext,
    host: string,
    port: number,
  ): boolean {
    try {
      this.ready();
      this.contexts.assert(context);
    } catch {
      return false;
    }
    if (networkHost(host) !== host || ![80, 443].includes(port)) return false;
    return [...(this.grants.get(context.conversationId)?.values() ?? [])].some(
      (g) =>
        this.validGrant(g, context) &&
        g.scope === "task" &&
        g.network.some((n) => n.host === host && n.port === port),
    );
  }
  private revokeGrant(id: string, grant: Grant) {
    grant.revoked = true;
    for (const e of this.entries.values())
      if (
        e.plan.invocation.conversationId === id &&
        e.plan.dependencies.some((d) => d.id === grant.id)
      ) {
        if (!e.dispatched) this.invalidateEntry(e);
        else if (
          grant.kind === "execution" &&
          grant.boundary?.target === "host-srt" &&
          e.state === "executing"
        )
          e.controller.abort();
      }
    this.options.onRevoke?.({
      conversationId: id,
      runId: grant.runId,
      grantId: grant.id,
      kind: grant.kind,
      ...(grant.boundary ? { target: grant.boundary.target } : {}),
      network: grant.network.map((n) => ({ ...n })),
    });
  }
  revoke(conversationId: string, grantId: string, owner: object) {
    this.requireReviewer(owner);
    const grant =
      this.grants.get(conversationId)?.get(grantId) ??
      [...this.entries.values()].find(
        (e) =>
          e.plan.invocation.conversationId === conversationId &&
          e.grant?.id === grantId &&
          active(e),
      )?.grant;
    if (!grant || grant.revoked) throw new PermissionError("PERMISSION_STALE");
    this.revokeGrant(conversationId, grant);
    this.touch(conversationId);
    this.changed(conversationId);
    return this.snapshot(conversationId);
  }
  async updateRules(
    input: PermissionRequests["permissionRulesUpdate"]["input"],
    owner: object,
  ) {
    input = permissionSchemas.permissionRulesUpdate.parse(input);
    this.requireReviewer(owner);
    this.ready();
    if (input.expectedRevision !== this.revision(input.conversationId))
      throw new PermissionError("PERMISSION_STALE");
    const ids = new Map(input.updates.map((v) => [v.ruleId, v.enabled]));
    if (
      [...ids.keys()].some(
        (id) =>
          this.updatingRules.has(id) ||
          !this.store.value.rules.some(
            (r) => r.id === id && r.conversationId === input.conversationId,
          ),
      )
    )
      throw new PermissionError("PERMISSION_DENIED");
    for (const id of ids.keys()) this.updatingRules.add(id);
    for (const e of this.entries.values())
      if (e.plan.dependencies.some((d) => d.kind === "rule" && ids.has(d.id)))
        this.invalidateEntry(e);
    this.touch(input.conversationId);
    try {
      await this.store.update(
        this.store.value.revision,
        this.store.value.rules.map((r) =>
          ids.has(r.id) ? { ...r, enabled: ids.get(r.id)! } : r,
        ),
      );
      this.changed(input.conversationId);
      return this.snapshot(input.conversationId);
    } finally {
      for (const id of ids.keys()) this.updatingRules.delete(id);
    }
  }
  private scheduleAudit() {
    if (this.closed || this.retryTimer || !this.pendingAudit.size) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flushAudit().finally(() => this.scheduleAudit());
    }, 1000);
    this.retryTimer.unref();
  }
  async flushAudit(): Promise<void> {
    for (const [key, item] of this.pendingAudit) {
      try {
        await this.audit.append(item.record);
      } catch {
        break;
      }
      if (this.pendingAudit.get(key) === item) {
        this.pendingAudit.delete(key);
        item.entry.auditPending = false;
        this.changed(item.entry.plan.invocation.conversationId, item.entry);
      }
    }
  }
  async execute<T>(
    plan: OperationPlan,
    validate: (plan: OperationPlan) => Promise<CurrentOperation>,
    effect: (payload: Json, signal: AbortSignal) => Promise<ConfirmedResult<T>>,
  ): Promise<T> {
    const e = this.lookup(plan);
    this.live(e);
    if (e.state !== "approved" || !this.validGrant(e.grant, plan.invocation))
      throw new PermissionError("PERMISSION_STALE");
    e.state = "reserved";
    this.changed(plan.invocation.conversationId, e);
    const signal = AbortSignal.any([
      plan.invocation.signal,
      e.controller.signal,
    ]);
    try {
      await this.audit.append(this.auditInput(e, "executing"));
      this.live(e);
      signal.throwIfAborted();
      const actual = await validate(plan);
      if (
        actual.payloadHash !== plan.payloadHash ||
        fingerprint(actual.expectedTargets) !==
          fingerprint(plan.expectedTargets) ||
        actual.connectionRevision !== plan.connectionRevision ||
        actual.executionTarget !== plan.executionTarget
      )
        throw new PermissionError("PERMISSION_STALE");
      this.live(e);
      signal.throwIfAborted();
      // No await between the last checks and dispatch. The deadline ends HERE.
      e.dispatched = true;
      e.state = "executing";
      clearTimeout(e.timer);
      const dispatched = effect(plan.payload, signal);
      this.changed(plan.invocation.conversationId, e);
      const outcome = await dispatched;
      if (!isConfirmedResult(outcome))
        throw new PermissionError("SIDE_EFFECT_UNKNOWN");
      e.state = "completed";
      // No permission/lifecycle revalidation after the adapter's confirmed commit.
      try {
        await this.audit.append(this.auditInput(e, "completed"));
      } catch {
        e.auditPending = true;
        this.pendingAudit.set(plan.id + ":completed", {
          entry: e,
          record: this.auditInput(e, "completed"),
        });
        this.scheduleAudit();
      }
      this.changed(plan.invocation.conversationId, e);
      return outcome.value as T;
    } catch (error) {
      if (e.state !== "completed") {
        e.state = e.dispatched ? "unknown" : "invalidated";
        await this.audit
          .append(this.auditInput(e, e.dispatched ? "unknown" : "failed"))
          .catch(() => {});
        this.changed(plan.invocation.conversationId, e);
      }
      if (e.dispatched) throw new PermissionError("SIDE_EFFECT_UNKNOWN");
      throw error;
    } finally {
      clearTimeout(e.timer);
    }
  }
}
