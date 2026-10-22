import { test, expect, vi } from "vitest";
import {
  attestExecutionBoundary,
  confirmedResult,
  retireExecutionBoundary,
} from "../../src/main/permissions/execution-contract";
import { deferred, fixture } from "./helpers";

const effect = (
  target: "vm" | "host-srt" = "vm",
  workspaceId = "synthetic-workspace",
) => ({
  tool: "bash",
  effects: [{ kind: "process.execute" as const, target, workspaceId }],
  executionTarget: target,
});
function proof(target: "vm" | "host-srt" = "vm") {
  return attestExecutionBoundary({
    target,
    conversationId: "conversation-a",
    runId: "run-a",
    workspaceId: "synthetic-workspace",
    revision: "verified-boot-a",
    files: true,
    network: true,
    termination: true,
  });
}
test("verified, task-bound commands run without per-command approvals even with no window", async () => {
  const f = await fixture();
  const context = f.service.contexts.create(
    "conversation-a",
    "run-a",
    "command-a",
    "agent",
  );
  expect(() => f.prepare(effect())).toThrow("CAPABILITY_UNSUPPORTED");
  f.service.authorizeExecution(context, proof());
  f.service.attachReviewer(undefined);
  for (const command of ["invented command one", "invented command two"]) {
    const p = f.prepare({ ...effect(), payload: { command } });
    expect(f.service.snapshot("conversation-a").pending).toEqual([]);
    await expect(f.execute(p, f.validate, async () => command)).resolves.toBe(
      command,
    );
  }
  expect(f.service.snapshot("conversation-a").backends.vm).toBe(false);
  expect(() => f.prepare(effect("vm", "another-workspace"))).toThrow(
    "CAPABILITY_UNSUPPORTED",
  );
});
test("attestations cannot be copied, moved to another run or used with unavailable capabilities", async () => {
  const f = await fixture();
  const context = f.service.contexts.create(
    "conversation-a",
    "run-a",
    "command-a",
    "agent",
  );
  expect(() => f.service.authorizeExecution(context, { ...proof() })).toThrow(
    "CAPABILITY_UNSUPPORTED",
  );
  expect(() =>
    attestExecutionBoundary({
      target: "vm",
      conversationId: "conversation-a",
      runId: "run-a",
      workspaceId: "synthetic-workspace",
      revision: "boot",
      files: true,
      network: false,
      termination: true,
    }),
  ).toThrow("CAPABILITY_UNSUPPORTED");
  const token = proof();
  f.service.beginTask("conversation-a", "other-run");
  const other = f.service.contexts.create(
    "conversation-a",
    "other-run",
    "call-b",
    "agent",
  );
  expect(() => f.service.authorizeExecution(other, token)).toThrow(
    "PERMISSION_DENIED",
  );
  const unavailable = await fixture({
    policy: { backends: { vm: false, hostSrt: false } },
  });
  expect(() =>
    unavailable.service.authorizeExecution(
      unavailable.service.contexts.create(
        "conversation-a",
        "run-a",
        "call-c",
        "agent",
      ),
      proof(),
    ),
  ).toThrow("CAPABILITY_UNSUPPORTED");
});
test("host execution needs the real reviewer; revocation requests stop only its dependent running command", async () => {
  const f = await fixture();
  const context = f.service.contexts.create(
    "conversation-a",
    "run-a",
    "host-a",
    "agent",
  );
  expect(() =>
    f.service.authorizeExecution(context, proof("host-srt")),
  ).toThrow("PERMISSION_DENIED");
  expect(() =>
    f.service.authorizeExecution(context, proof("host-srt"), { ...f.owner }),
  ).toThrow("PERMISSION_DENIED");
  const grant = f.service.authorizeExecution(
    context,
    proof("host-srt"),
    f.owner,
  );
  const p = f.prepare(effect("host-srt"));
  const entered = deferred<AbortSignal>();
  const release = deferred();
  const running = f.execute(p, f.validate, async (_payload, signal) => {
    entered.resolve(signal);
    await release.promise;
    return "adapter confirmed cleanup";
  });
  const signal = await entered.promise;
  f.service.revoke("conversation-a", grant, f.owner);
  expect(signal.aborted).toBe(true);
  expect(context.signal.aborted).toBe(false);
  expect(() => f.prepare(effect("host-srt"))).toThrow("CAPABILITY_UNSUPPORTED");
  release.resolve();
  await running;
});
test("network revocation preserves a running command but denies its subsequent new connections", async () => {
  const f = await fixture();
  const context = f.service.contexts.create(
    "conversation-a",
    "run-a",
    "vm-a",
    "agent",
  );
  f.service.authorizeExecution(context, proof());
  const network = f.prepare();
  const permission = (await f.approve(network, "task")).grants.find(
    (g) => g.kind === "operation",
  )!;
  expect(f.service.networkAllowed(context, "example.test", 443)).toBe(true);
  const p = f.prepare(effect());
  const entered = deferred<AbortSignal>();
  const release = deferred();
  const running = f.execute(p, f.validate, async (_payload, signal) => {
    entered.resolve(signal);
    await release.promise;
    return "finished offline work";
  });
  const signal = await entered.promise;
  f.service.revoke("conversation-a", permission.id, f.owner);
  expect(signal.aborted).toBe(false);
  expect(f.service.networkAllowed(context, "example.test", 443)).toBe(false);
  const next = f.prepare();
  expect(
    f.service
      .snapshot("conversation-a")
      .pending.some((request) => request.id === next.id),
  ).toBe(true);
  release.resolve();
  await running;
});
test("a normal or guest-shaped callback result is not an adapter completion confirmation", async () => {
  const f = await fixture();
  const p = f.prepare();
  await f.approve(p);
  await expect(
    f.service.execute(
      p,
      f.validate,
      async () =>
        ({ status: "completed", value: "untrusted guest result" }) as never,
    ),
  ).rejects.toThrow("SIDE_EFFECT_UNKNOWN");
  expect(f.events.at(-1)?.state).toBe("unknown");
  const next = f.prepare();
  await f.approve(next);
  await expect(
    f.service.execute(next, f.validate, async () =>
      confirmedResult("trusted final publication"),
    ),
  ).resolves.toBe("trusted final publication");
});
test("an unconfirmed adapter exception after dispatch has an explicit unknown-side-effect code", async () => {
  const f = await fixture();
  const p = f.prepare();
  await f.approve(p);
  await expect(
    f.service.execute(p, f.validate, async () => {
      throw new Error("synthetic response lost after sending");
    }),
  ).rejects.toThrow("SIDE_EFFECT_UNKNOWN");
  expect(f.events.at(-1)?.state).toBe("unknown");
});
test("the plan timer cannot abort an already-dispatched operation", async () => {
  const f = await fixture();
  const entered = deferred<AbortSignal>();
  const release = deferred();
  vi.useFakeTimers();
  try {
    const p = f.prepare();
    await f.approve(p);
    const running = f.execute(p, f.validate, async (_payload, signal) => {
      entered.resolve(signal);
      await release.promise;
      return "long operation";
    });
    const signal = await entered.promise;
    f.advance(600001);
    await vi.advanceTimersByTimeAsync(600001);
    expect(signal.aborted).toBe(false);
    release.resolve();
    await expect(running).resolves.toBe("long operation");
  } finally {
    vi.useRealTimers();
  }
});
test("retiring a backend boot attestation prevents an old prepared command from dispatching", async () => {
  const f = await fixture();
  const context = f.service.contexts.create(
    "conversation-a",
    "run-a",
    "call-a",
    "agent",
  );
  const boundary = proof();
  f.service.authorizeExecution(context, boundary);
  const plan = f.prepare(effect());
  retireExecutionBoundary(boundary);
  const adapter = vi.fn(async () => confirmedResult("unexpected"));
  await expect(f.service.execute(plan, f.validate, adapter)).rejects.toThrow(
    "CAPABILITY_UNSUPPORTED",
  );
  expect(adapter).not.toHaveBeenCalled();
});
