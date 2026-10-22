import { describe, test, expect, vi } from "vitest";
import { deferred, fixture, readRule } from "./helpers";

describe("v2.5 dispatch and lifecycle regressions", () => {
  test("private-rule revisions still reject stale edits when the conversation has no active task", async () => {
    const rule = readRule();
    const f = await fixture({ rules: [rule] });
    f.service.endTask("conversation-a");
    const before = f.service.snapshot("conversation-a").revision;
    const updated = await f.service.updateRules(
      {
        conversationId: "conversation-a",
        expectedRevision: before,
        updates: [{ ruleId: rule.id, enabled: false }],
      },
      f.owner,
    );
    expect(updated.revision).not.toBe(before);
    await expect(
      f.service.updateRules(
        {
          conversationId: "conversation-a",
          expectedRevision: before,
          updates: [{ ruleId: rule.id, enabled: true }],
        },
        f.owner,
      ),
    ).rejects.toThrow("PERMISSION_STALE");
  });
  test("the replacement window can reserve a reply before the old document's audit callback returns", async () => {
    const f = await fixture();
    const p = f.prepare();
    const entered = deferred();
    const release = deferred();
    const append = f.audit.append.bind(f.audit);
    vi.spyOn(f.audit, "append").mockImplementationOnce(async (record) => {
      entered.resolve();
      await release.promise;
      return append(record);
    });
    const old = f.approve(p);
    const rejected = expect(old).rejects.toThrow("PERMISSION_DENIED");
    await entered.promise;
    f.service.attachReviewer(undefined);
    const replacement = {};
    f.service.attachReviewer(replacement);
    await f.service.reply(
      {
        conversationId: "conversation-a",
        requestId: p.id,
        decision: "allow",
        scope: "once",
      },
      replacement,
    );
    release.resolve();
    await rejected;
    await expect(
      f.execute(p, f.validate, async () => "new owner's approval"),
    ).resolves.toBe("new owner's approval");
  });
  test("an old in-flight reply does not destroy the request the new window can approve", async () => {
    const f = await fixture();
    const plan = f.prepare();
    const entered = deferred();
    const release = deferred();
    const append = f.audit.append.bind(f.audit);
    const spy = vi
      .spyOn(f.audit, "append")
      .mockImplementationOnce(async (record) => {
        entered.resolve();
        await release.promise;
        return append(record);
      });
    const oldReply = f.approve(plan);
    const rejected = expect(oldReply).rejects.toThrow("PERMISSION_DENIED");
    await entered.promise;
    f.service.attachReviewer(undefined);
    const replacement = {};
    f.service.attachReviewer(replacement);
    release.resolve();
    await rejected;
    expect(f.service.snapshot("conversation-a").pending[0]?.id).toBe(plan.id);
    spy.mockRestore();
    await f.service.reply(
      {
        conversationId: "conversation-a",
        requestId: plan.id,
        decision: "allow",
        scope: "once",
      },
      replacement,
    );
    await expect(
      f.execute(plan, f.validate, async () => "approved by successor"),
    ).resolves.toBe("approved by successor");
  });
  test("a changed read rule invalidates its undispatched dependents but not an already-dispatched read", async () => {
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
    const running = f.prepare(read);
    await expect(
      f.execute(running, f.validate, async (_payload, signal) => {
        await f.service.updateRules(
          {
            conversationId: "conversation-a",
            expectedRevision: f.service.snapshot("conversation-a").revision,
            updates: [{ ruleId: rule.id, enabled: false }],
          },
          f.owner,
        );
        expect(signal.aborted).toBe(false);
        return "confirmed read";
      }),
    ).resolves.toBe("confirmed read");
    const adapter = vi.fn(async () => "unexpected");
    await expect(f.execute(pending, f.validate, adapter)).rejects.toThrow(
      "PERMISSION_STALE",
    );
    expect(adapter).not.toHaveBeenCalled();
  });
  test("capacity exhaustion is distinguished from permission denial", async () => {
    const f = await fixture();
    for (let i = 0; i < 512; i++) f.prepare();
    expect(() => f.prepare()).toThrow("PERMISSION_CAPACITY_EXCEEDED");
  });
  test("a dispatched operation can complete after its plan deadline", async () => {
    const f = await fixture();
    const p = f.prepare();
    f.advance(540000);
    await f.approve(p);
    const result = f.execute(p, f.validate, async () => {
      f.advance(60001);
      return "confirmed write";
    });
    await expect(result).resolves.toBe("confirmed write");
    expect(f.events.at(-1)?.state).toBe("completed");
  });
  test("revocation after dispatch preserves a confirmed success", async () => {
    const f = await fixture();
    const p = f.prepare();
    const grant = (await f.approve(p)).grants[0];
    const result = f.execute(p, f.validate, async () => {
      f.service.revoke("conversation-a", grant.id, f.owner);
      return "confirmed write";
    });
    await expect(result).resolves.toBe("confirmed write");
  });
  test("completed writes survive completion-audit failure", async () => {
    const f = await fixture();
    const p = f.prepare();
    await f.approve(p);
    const append = f.audit.append.bind(f.audit);
    vi.spyOn(f.audit, "append").mockImplementation((record) =>
      record.event === "completed"
        ? Promise.reject(new Error("synthetic full disk"))
        : append(record),
    );
    await expect(
      f.execute(p, f.validate, async () => "confirmed write"),
    ).resolves.toBe("confirmed write");
    expect(f.events.at(-1)?.state).toBe("completed");
  });
  test("task authorization remains valid after ten minutes in the same run", async () => {
    const f = await fixture();
    const first = f.prepare();
    await f.approve(first, "task");
    f.advance(660000);
    const next = f.prepare();
    expect(f.service.snapshot("conversation-a").pending).toEqual([]);
    await expect(
      f.execute(next, f.validate, async () => "same task"),
    ).resolves.toBe("same task");
  });
  test("rule-backed reads do not require an open approval window", async () => {
    const rule = readRule();
    const f = await fixture({ rules: [rule] });
    f.service.attachReviewer(undefined);
    const p = f.prepare({
      effects: [
        {
          kind: "file.read",
          target: { path: rule.path, identity: rule.identity, ancestors: [] },
        },
      ],
    });
    await expect(
      f.execute(p, f.validate, async () => "read result"),
    ).resolves.toBe("read result");
  });
  test("pending requests survive window disconnect and can be answered by the replacement", async () => {
    const f = await fixture();
    const p = f.prepare();
    f.service.attachReviewer(undefined);
    const replacement = {};
    f.service.attachReviewer(replacement);
    expect(f.service.snapshot("conversation-a").pending[0]?.id).toBe(p.id);
    await expect(
      f.service.reply(
        {
          conversationId: "conversation-a",
          requestId: p.id,
          decision: "allow",
          scope: "once",
        },
        replacement,
      ),
    ).resolves.toBeDefined();
  });
  test("window disconnect preserves an approved, undispatched operation", async () => {
    const f = await fixture();
    const p = f.prepare();
    await f.approve(p);
    f.service.attachReviewer(undefined);
    await expect(
      f.execute(p, f.validate, async () => "approved result"),
    ).resolves.toBe("approved result");
  });
  test("private rule changes do not invalidate another conversation's prepared work", async () => {
    const rule = readRule();
    const f = await fixture({ rules: [rule] });
    f.service.beginTask("conversation-b", "run-b");
    const p = f.prepare({}, "conversation-b", "run-b");
    await f.approve(p);
    await f.service.updateRules(
      {
        conversationId: "conversation-a",
        expectedRevision: f.service.snapshot("conversation-a").revision,
        updates: [{ ruleId: rule.id, enabled: false }],
      },
      f.owner,
    );
    await expect(
      f.execute(p, f.validate, async () => "independent result"),
    ).resolves.toBe("independent result");
  });
  test("changing an unrelated rule in the same conversation preserves an approval", async () => {
    const rule = readRule();
    const f = await fixture({ rules: [rule] });
    const p = f.prepare();
    await f.approve(p);
    await f.service.updateRules(
      {
        conversationId: "conversation-a",
        expectedRevision: f.service.snapshot("conversation-a").revision,
        updates: [{ ruleId: rule.id, enabled: false }],
      },
      f.owner,
    );
    await expect(
      f.execute(p, f.validate, async () => "unrelated result"),
    ).resolves.toBe("unrelated result");
  });
  test("revocation during target validation still prevents dispatch", async () => {
    const f = await fixture();
    const p = f.prepare();
    const grant = (await f.approve(p)).grants[0];
    const entered = deferred();
    const release = deferred();
    const effect = vi.fn(async () => "unexpected");
    const running = f.execute(
      p,
      async (plan) => {
        entered.resolve();
        await release.promise;
        return f.validate(plan);
      },
      effect,
    );
    const outcome = expect(running).rejects.toThrow("PERMISSION_STALE");
    await entered.promise;
    f.service.revoke("conversation-a", grant.id, f.owner);
    release.resolve();
    await outcome;
    expect(effect).not.toHaveBeenCalled();
  });
});
