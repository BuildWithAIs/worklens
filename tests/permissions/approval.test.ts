import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { deferred, encryption, fixture, input, readRule } from "./helpers";
import { fingerprint } from "../../src/main/permissions/operation-plan";
import { permissionHandlers } from "../../src/main/permissions/ipc";

describe("permission approval and commit fences", () => {
  test("an adapter can wait for approval without blocking an independent operation", async () => {
    const f = await fixture();
    const waiting = f.prepare();
    const other = f.prepare();
    let resumed = false;
    const paused = f.service.waitForApproval(waiting).then(() => {
      resumed = true;
    });
    await f.approve(other);
    await f.execute(other, f.validate, async () => "independent result");
    expect(resumed).toBe(false);
    await f.approve(waiting);
    await paused;
    expect(resumed).toBe(true);
  });
  test.each(["deny", "cancel", "audit-failure"])(
    "%s releases an operation waiting for approval",
    async (cause) => {
      const f = await fixture();
      const plan = f.prepare();
      const paused = f.service.waitForApproval(plan);
      const outcome = expect(paused).rejects.toThrow(
        /PERMISSION_(DENIED|STALE)/,
      );
      if (cause === "deny")
        await f.service.reply(
          {
            conversationId: "conversation-a",
            requestId: plan.id,
            decision: "deny",
            scope: "once",
          },
          f.owner,
        );
      if (cause === "cancel") f.service.endTask("conversation-a", "run-a");
      if (cause === "audit-failure") {
        vi.spyOn(f.audit, "append").mockRejectedValueOnce(
          new Error("synthetic audit failure"),
        );
        await expect(f.approve(plan)).rejects.toThrow(
          "synthetic audit failure",
        );
      }
      await outcome;
    },
  );
  test("the core validates and snapshots a reply before asynchronous work", async () => {
    const f = await fixture();
    const plan = f.prepare({
      effects: [
        {
          kind: "service.mutate",
          connectionId: "synthetic-connection",
          revision: "v1",
          resource: "item-a",
          action: "update",
        },
      ],
    });
    const entered = deferred();
    const release = deferred();
    const append = f.audit.append.bind(f.audit);
    vi.spyOn(f.audit, "append").mockImplementation(async (record) => {
      entered.resolve();
      await release.promise;
      return append(record);
    });
    const request = {
      conversationId: "conversation-a",
      requestId: plan.id,
      decision: "allow" as const,
      scope: "once" as "once" | "task",
    };
    const approving = f.service.reply(request, f.owner);
    await entered.promise;
    request.scope = "task";
    release.resolve();
    expect((await approving).grants[0].scope).toBe("once");
    const another = f.prepare();
    await expect(
      f.service.reply(
        {
          conversationId: "conversation-a",
          requestId: another.id,
          decision: "invented-invalid-decision",
          scope: "once",
        } as never,
        f.owner,
      ),
    ).rejects.toThrow();
    expect(f.service.snapshot("conversation-a").pending[0].id).toBe(another.id);
  });

  test("revocation during audit persistence prevents even the target validation callback", async () => {
    const f = await fixture();
    const plan = f.prepare();
    const approved = await f.approve(plan);
    const entered = deferred();
    const release = deferred();
    const append = f.audit.append.bind(f.audit);
    vi.spyOn(f.audit, "append").mockImplementation(async (record) => {
      entered.resolve();
      await release.promise;
      return append(record);
    });
    const validate = vi.fn(f.validate);
    const effect = vi.fn(async () => "unexpected");
    const running = f.execute(plan, validate, effect);
    const outcome = expect(running).rejects.toThrow("PERMISSION_STALE");
    await entered.promise;
    f.service.revoke("conversation-a", approved.grants[0].id, f.owner);
    release.resolve();
    await outcome;
    expect(validate).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
  });

  test("an old document's reply cannot activate after reviewer replacement during audit persistence", async () => {
    const f = await fixture();
    const plan = f.prepare();
    const entered = deferred();
    const release = deferred();
    const append = f.audit.append.bind(f.audit);
    vi.spyOn(f.audit, "append").mockImplementation(async (record) => {
      entered.resolve();
      await release.promise;
      return append(record);
    });
    const approving = f.approve(plan);
    const outcome = expect(approving).rejects.toThrow("PERMISSION_DENIED");
    await entered.promise;
    f.service.attachReviewer(undefined);
    f.service.attachReviewer({ window: "replacement-document" });
    release.resolve();
    await outcome;
    expect(f.service.snapshot("conversation-a").grants).toEqual([]);
  });

  test("cancelling one task leaves a different conversation's approval usable", async () => {
    const f = await fixture();
    const first = f.prepare();
    await f.approve(first);
    f.service.beginTask("conversation-b", "run-b");
    const second = f.prepare({}, "conversation-b", "run-b");
    await f.approve(second);
    f.service.endTask("conversation-a", "run-a");
    await expect(
      f.execute(second, f.validate, async () => "independent result"),
    ).resolves.toBe("independent result");
    await expect(
      f.execute(first, f.validate, async () => "unexpected"),
    ).rejects.toThrow("PERMISSION_STALE");
  });
  test("freezes the exact payload, exposes only reviewed details and requires the actual main reviewer", async () => {
    const f = await fixture();
    const mutable = input({
      payload: { secret: "synthetic-private-value" },
      review: { receiver: "example.test", note: "synthetic-private-value" },
    });
    const context = f.service.contexts.create(
      "conversation-a",
      "run-a",
      "call-a",
      "agent",
    );
    const plan = f.service.prepare(context, mutable);
    mutable.payload = { secret: "changed" };
    expect(plan.payloadHash).toBe(
      fingerprint({ secret: "synthetic-private-value" }),
    );
    expect(Object.isFrozen(plan.payload)).toBe(true);
    const view = f.service.snapshot("conversation-a");
    expect(view.enforcement).toBe("not-connected");
    expect(view.backends).toEqual({
      vm: false,
      hostSrt: false,
      fileBoundary: false,
    });
    expect(view.pending[0].details).toEqual({
      receiver: "example.test",
      note: "[redacted]",
    });
    expect(JSON.stringify(view)).not.toContain("synthetic-private-value");
    await expect(
      f.service.reply(
        {
          conversationId: "conversation-a",
          requestId: plan.id,
          decision: "allow",
          scope: "once",
        },
        { ...f.owner },
      ),
    ).rejects.toThrow("PERMISSION_DENIED");
    await f.approve(plan);
    const effect = vi.fn(async (payload) => payload);
    await expect(f.execute({ ...plan }, f.validate, effect)).rejects.toThrow(
      "PERMISSION_STALE",
    );
    expect(await f.execute(plan, f.validate, effect)).toEqual({
      secret: "synthetic-private-value",
    });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  test("two simultaneous executions cannot consume one approval twice", async () => {
    const f = await fixture();
    const plan = f.prepare();
    await f.approve(plan);
    const entered = deferred();
    const release = deferred();
    const effect = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return "done";
    });
    const first = f.execute(plan, f.validate, effect);
    const second = f.execute(plan, f.validate, effect);
    await expect(second).rejects.toThrow("PERMISSION_STALE");
    await entered.promise;
    release.resolve();
    await expect(first).resolves.toBe("done");
    await expect(f.execute(plan, f.validate, effect)).rejects.toThrow(
      "PERMISSION_STALE",
    );
    expect(effect).toHaveBeenCalledTimes(1);
  });

  test("reserves a pending reply before awaiting audit persistence", async () => {
    const f = await fixture();
    const plan = f.prepare();
    const entered = deferred();
    const release = deferred();
    const append = f.audit.append.bind(f.audit);
    vi.spyOn(f.audit, "append").mockImplementation(async (record) => {
      entered.resolve();
      await release.promise;
      await append(record);
    });
    const first = f.approve(plan);
    await entered.promise;
    await expect(f.approve(plan)).rejects.toThrow("PERMISSION_STALE");
    release.resolve();
    await first;
    expect(f.service.snapshot("conversation-a").grants).toHaveLength(1);
  });

  test.each(["payload", "target", "connection", "backend"])(
    "rejects a changed %s before invoking the adapter",
    async (field) => {
      const f = await fixture();
      const plan = f.prepare({ connectionRevision: "connection-v1" });
      await f.approve(plan);
      const effect = vi.fn(async () => "unexpected");
      const validate = async () => ({
        ...(await f.validate(plan)),
        ...(field === "payload"
          ? { payloadHash: fingerprint("changed") }
          : field === "target"
            ? { expectedTargets: { destination: "test-service-v2" } }
            : field === "connection"
              ? { connectionRevision: "connection-v2" }
              : { executionTarget: "host-srt" as const }),
      });
      await expect(f.execute(plan, validate, effect)).rejects.toThrow(
        "PERMISSION_STALE",
      );
      expect(effect).not.toHaveBeenCalled();
      await expect(f.execute(plan, f.validate, effect)).rejects.toThrow(
        "PERMISSION_STALE",
      );
    },
  );

  test.each(["revoke", "task-end", "expire"])(
    "%s during final validation prevents side effects",
    async (cause) => {
      const f = await fixture();
      const plan = f.prepare();
      const approved = await f.approve(plan);
      const entered = deferred();
      const release = deferred();
      const effect = vi.fn(async () => "unexpected");
      const running = f.execute(
        plan,
        async (p) => {
          entered.resolve();
          await release.promise;
          return f.validate(p);
        },
        effect,
      );
      const outcome = expect(running).rejects.toThrow(
        /PERMISSION_(STALE|EXPIRED)/,
      );
      await entered.promise;
      if (cause === "revoke")
        f.service.revoke("conversation-a", approved.grants[0].id, f.owner);
      if (cause === "task-end") f.service.endTask("conversation-a", "run-a");
      if (cause === "expire") f.advance(600001);
      release.resolve();
      await outcome;
      expect(effect).not.toHaveBeenCalled();
    },
  );

  test("cancellation aborts the adapter but preserves its confirmed result on the original run", async () => {
    const f = await fixture();
    const plan = f.prepare();
    await f.approve(plan);
    const entered = deferred<AbortSignal>();
    const release = deferred();
    const effect = vi.fn(async (_payload, signal: AbortSignal) => {
      entered.resolve(signal);
      await release.promise;
      return "remote response";
    });
    const running = f.execute(plan, f.validate, effect);
    const outcome = expect(running).resolves.toBe("remote response");
    const signal = await entered.promise;
    f.service.endTask("conversation-a", "run-a");
    expect(signal.aborted).toBe(true);
    f.service.beginTask("conversation-a", "replacement-run");
    release.resolve();
    await outcome;
    expect(f.events.at(-1)).toMatchObject({
      state: "completed",
      runId: "run-a",
      operationId: plan.id,
    });
    await expect(f.execute(plan, f.validate, effect)).rejects.toThrow();
    expect(effect).toHaveBeenCalledTimes(1);
  });

  test("task grants stay inside resource, adapter, execution target and run boundaries", async () => {
    const f = await fixture();
    const first = f.prepare();
    await f.approve(first, "task");
    const reused = f.prepare({
      payload: { url: "https://example.test/another" },
    });
    const effect = vi.fn(async () => "done");
    await f.execute(reused, f.validate, effect);
    const otherHost = f.prepare({
      effects: [{ kind: "network.connect", host: "other.test", port: 443 }],
    });
    const otherPort = f.prepare({
      effects: [{ kind: "network.connect", host: "example.test", port: 80 }],
    });
    const otherAdapter = f.prepare({ tool: "other-adapter" });
    const otherBackend = f.prepare({ executionTarget: "host-srt" });
    expect(
      f.service.snapshot("conversation-a").pending.map((p) => p.id),
    ).toEqual([otherHost.id, otherPort.id, otherAdapter.id, otherBackend.id]);
    f.service.beginTask("conversation-b", "run-b");
    const otherConversation = f.prepare({}, "conversation-b", "run-b");
    expect(f.service.snapshot("conversation-b").pending[0].id).toBe(
      otherConversation.id,
    );
    f.service.endTask("conversation-a", "run-a");
    f.service.beginTask("conversation-a", "run-new");
    const newRun = f.prepare({}, "conversation-a", "run-new");
    expect(f.service.snapshot("conversation-a").pending[0].id).toBe(newRun.id);
    expect(f.service.snapshot("conversation-a").grants).toEqual([]);
  });

  test("denied, expired and cross-conversation replies cannot be revived", async () => {
    const f = await fixture();
    const plan = f.prepare();
    await expect(
      f.service.reply(
        {
          conversationId: "conversation-b",
          requestId: plan.id,
          decision: "allow",
          scope: "once",
        },
        f.owner,
      ),
    ).rejects.toThrow("PERMISSION_STALE");
    await f.service.reply(
      {
        conversationId: "conversation-a",
        requestId: plan.id,
        decision: "deny",
        scope: "once",
      },
      f.owner,
    );
    await expect(f.approve(plan)).rejects.toThrow("PERMISSION_STALE");
    const expired = f.prepare();
    f.advance(600001);
    await expect(f.approve(expired)).rejects.toThrow("PERMISSION_EXPIRED");
    expect(f.service.snapshot("conversation-a").pending).toEqual([]);
  });

  test("blocks only dependencies on a rule while its new state is being persisted", async () => {
    const rule = readRule();
    const f = await fixture({ rules: [rule] });
    const read = {
      effects: [
        {
          kind: "file.read" as const,
          target: { path: rule.path, identity: rule.identity, ancestors: [] },
        },
      ],
    };
    const pending = f.prepare(read);
    const entered = deferred();
    const release = deferred();
    const update = f.store.update.bind(f.store);
    vi.spyOn(f.store, "update").mockImplementation(async (revision, rules) => {
      entered.resolve();
      await release.promise;
      await update(revision, rules);
    });
    const changing = f.service.updateRules(
      {
        conversationId: "conversation-a",
        expectedRevision: f.service.snapshot("conversation-a").revision,
        updates: [{ ruleId: rule.id, enabled: false }],
      },
      f.owner,
    );
    await entered.promise;
    expect(() => f.prepare()).not.toThrow();
    const during = f.prepare(read);
    expect(
      f.service
        .snapshot("conversation-a")
        .pending.some((p) => p.id === during.id),
    ).toBe(true);
    await expect(f.execute(pending, f.validate, vi.fn())).rejects.toThrow(
      "PERMISSION_STALE",
    );
    release.resolve();
    await changing;
    const next = f.prepare({
      effects: [
        {
          kind: "file.read",
          target: { path: rule.path, identity: rule.identity, ancestors: [] },
        },
      ],
    });
    expect(
      f.service
        .snapshot("conversation-a")
        .pending.some((p) => p.id === next.id),
    ).toBe(true);
    await expect(
      f.service.updateRules(
        {
          conversationId: "conversation-a",
          expectedRevision: "old",
          updates: [{ ruleId: rule.id, enabled: true }],
        },
        f.owner,
      ),
    ).rejects.toThrow("PERMISSION_STALE");
  });

  test("audit failure prevents dispatch but cannot erase a confirmed outcome", async () => {
    const f = await fixture();
    const plan = f.prepare();
    await f.approve(plan);
    const effect = vi.fn(async () => "unexpected");
    await writeFile(join(f.root, "audit.json"), "corrupt");
    // Reload simulates a damaged record, never overwrite it with empty defaults.
    await f.audit.load();
    await expect(f.execute(plan, f.validate, effect)).rejects.toThrow(
      "PERMISSION_AUDIT_UNAVAILABLE",
    );
    expect(effect).not.toHaveBeenCalled();
    expect(await readFile(join(f.root, "audit.json"), "utf8")).toBe("corrupt");
    const g = await fixture();
    const dispatched = g.prepare();
    await g.approve(dispatched);
    const running = g.execute(dispatched, g.validate, async () => {
      vi.spyOn(g.audit, "append").mockRejectedValue(
        new Error("synthetic write failure"),
      );
      return "sent";
    });
    await expect(running).resolves.toBe("sent");
    expect(g.events.at(-1)).toMatchObject({
      state: "completed",
      auditPending: true,
    });
    vi.mocked(g.audit.append).mockRestore();
    await g.service.flushAudit();
    expect(g.events.at(-1)?.auditPending).toBeUndefined();
  });

  test("audit records identify source and execution without retaining review or raw payload", async () => {
    const f = await fixture();
    const plan = f.prepare({
      payload: { token: "synthetic-private-value" },
      review: { message: "invented-preview" },
    });
    await f.approve(plan);
    await f.execute(plan, f.validate, async () => "done");
    const envelope = JSON.parse(
      await readFile(join(f.root, "audit.json"), "utf8"),
    );
    const log = JSON.parse(
      encryption.decryptString(Buffer.from(envelope.encrypted, "base64")),
    );
    expect(log.records.map((r: { event: string }) => r.event)).toEqual([
      "approved",
      "executing",
      "completed",
    ]);
    expect(log.records[0]).toMatchObject({
      authorization: "user",
      origin: "agent",
      runId: "run-a",
      executionId: plan.invocation.executionId,
      invocationId: plan.invocation.id,
      effects: ["network.connect"],
    });
    expect(JSON.stringify(log)).not.toMatch(
      /synthetic-private-value|invented-preview|example\.test/,
    );
    expect(f.events.map((e) => e.sequence)).toEqual(
      f.events.map((_, i) => i + 1),
    );
  });

  test("IPC accepts replies only; payloads, forged approval fields and arbitrary paths are rejected", async () => {
    const f = await fixture();
    const plan = f.prepare();
    const handlers = permissionHandlers(f.service, () => f.owner);
    const reply = {
      conversationId: "conversation-a",
      requestId: plan.id,
      decision: "allow" as const,
      scope: "once" as const,
    };
    expect(() =>
      handlers.permissionReply({ ...reply, approved: true } as typeof reply),
    ).toThrow();
    expect(() =>
      handlers.permissionReply({
        ...reply,
        payload: { changed: true },
      } as typeof reply),
    ).toThrow();
    expect(() =>
      handlers.permissionSelectFiles({
        conversationId: "conversation-a",
        intent: "read",
      }),
    ).toThrow("CAPABILITY_UNSUPPORTED");
    expect(() =>
      handlers.permissionRulesUpdate({
        conversationId: "conversation-a",
        expectedRevision: "x",
        updates: [
          { ruleId: "invalid", enabled: true, path: "/synthetic/elsewhere" },
        ],
      } as unknown as Parameters<typeof handlers.permissionRulesUpdate>[0]),
    ).toThrow();
    const detached = permissionHandlers(f.service, () => undefined);
    expect(() =>
      detached.permissionsGet({ conversationId: "conversation-a" }),
    ).toThrow("PERMISSION_DENIED");
    await handlers.permissionReply(reply);
    expect(
      handlers.permissionsGet({ conversationId: "conversation-a" }).pending,
    ).toEqual([]);
  });
});
