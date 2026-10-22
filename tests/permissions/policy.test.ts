import { describe, expect, test } from "vitest";
import { InvocationContexts } from "../../src/main/permissions/invocation-context";
import {
  canonical,
  operationPlan,
} from "../../src/main/permissions/operation-plan";
import {
  atOrUnder,
  networkHost,
  PolicyService,
} from "../../src/main/permissions/policy-service";
import type {
  OperationEffect,
  PolicySettings,
} from "../../src/main/permissions/types";
import { input, readRule } from "./helpers";

function plan(
  effects: OperationEffect[],
  executionTarget: "trusted-main" | "vm" | "host-srt" = "trusted-main",
) {
  const contexts = new InvocationContexts();
  contexts.begin("conversation-a", "run-a");
  return operationPlan(
    contexts.create("conversation-a", "run-a", "call-a", "agent"),
    input({ effects, executionTarget }),
    "revision-a",
    Date.now() + 60000,
  );
}
const settings = (): PolicySettings => ({
  protectedPaths: ["/synthetic/control"],
  deniedPaths: ["/synthetic/project/private"],
  readRules: [readRule()],
  fileBoundary: true,
  backends: { vm: true, hostSrt: true },
});

describe("bounded, immutable operation inputs", () => {
  test("canonical JSON ignores insertion order but preserves array order", () => {
    expect(canonical({ b: 1, a: [2, 3] })).toBe(canonical({ a: [2, 3], b: 1 }));
    expect(canonical([2, 3])).not.toBe(canonical([3, 2]));
  });
  test("rejects coercion, cycles, accessors and oversized structures without invoking getters", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let accessed = false;
    const getter = {
      get value() {
        accessed = true;
        return "unexpected";
      },
    };
    for (const value of [
      NaN,
      Infinity,
      undefined,
      new Date(),
      { n: undefined },
      [1, , 2],
      cycle,
      getter,
      "x".repeat(1024 * 1024 + 1),
      Array(20001).fill(null),
      { [Symbol("hidden")]: 1 },
      Object.defineProperty({}, "hidden", { value: 1 }),
    ]) {
      expect(() => canonical(value)).toThrow();
    }
    let deep: unknown = null;
    for (let i = 0; i < 34; i++) deep = { deep };
    expect(() => canonical(deep)).toThrow();
    expect(accessed).toBe(false);
  });
  test("rejects custom array methods before using them", () => {
    let invoked = false;
    const array = [1, 2];
    Object.defineProperty(array, "map", {
      value: () => {
        invoked = true;
        return [];
      },
    });
    expect(() => canonical(array)).toThrow();
    expect(invoked).toBe(false);
  });
});

describe("trusted invocation provenance", () => {
  test("rejects copied identities, preserves parent identity and invalidates old task epochs", () => {
    const contexts = new InvocationContexts();
    contexts.begin("conversation-a", "run-a");
    const parent = contexts.create(
      "conversation-a",
      "run-a",
      "parent-a",
      "agent",
    );
    const child = contexts.create(
      "conversation-a",
      "run-a",
      "child-a",
      "agent",
      parent,
    );
    expect(child).toMatchObject({
      parentInvocationId: parent.id,
      parentToolCallId: "parent-a",
      runId: "run-a",
    });
    expect(child.executionId).not.toBe(parent.executionId);
    expect(() => contexts.assert({ ...child })).toThrow("PERMISSION_STALE");
    contexts.begin("conversation-b", "run-b");
    expect(() =>
      contexts.create("conversation-b", "run-b", "child-b", "agent", parent),
    ).toThrow("PERMISSION_DENIED");
    contexts.invalidate("conversation-a");
    expect(child.signal.aborted).toBe(true);
    expect(() => contexts.assert(child)).toThrow("PERMISSION_STALE");
    const fresh = contexts.create("conversation-a", "run-a", "fresh", "agent");
    expect(() => contexts.assert(fresh)).not.toThrow();
    contexts.begin("conversation-a", "run-next");
    contexts.end("conversation-a", "run-a");
    expect(contexts.current("conversation-a")?.runId).toBe("run-next");
    contexts.close();
    expect(contexts.current("conversation-a")).toBeUndefined();
  });
});

describe("policy precedence and resource boundaries", () => {
  const policy = new PolicyService();
  const file = (
    path: string,
    identity = "volume-a:file-1",
    ancestors = [{ path: "/synthetic/project", identity: "volume-a:node-7" }],
  ): Extract<OperationEffect, { target: object }> => ({
    kind: "file.read",
    target: { path, identity, ancestors },
  });

  test("a hard deny wins over another effect that needs approval or already has a read rule", () => {
    const effects: OperationEffect[] = [
      { kind: "network.connect", host: "example.test", port: 443 },
      file("/synthetic/control/rules.json"),
    ];
    expect(policy.evaluate(plan(effects), settings())).toEqual({
      kind: "deny",
      code: "PERMISSION_DENIED",
    });
    expect(
      policy.evaluate(
        plan([file("/synthetic/project/private/item")]),
        settings(),
      ).kind,
    ).toBe("deny");
    expect(
      policy.evaluate(
        plan([file("/synthetic/control/../project/item")]),
        settings(),
      ).kind,
    ).toBe("allow");
  });
  test("read rules require component containment and a matching current root identity", () => {
    expect(
      atOrUnder("/synthetic/project-other/item", "/synthetic/project"),
    ).toBe(false);
    expect(atOrUnder("relative", "/synthetic/project")).toBe(false);
    expect(
      policy.evaluate(plan([file("/synthetic/project/item")]), settings()).kind,
    ).toBe("allow");
    expect(
      policy.evaluate(plan([file("/synthetic/project-other/item")]), settings())
        .kind,
    ).toBe("ask");
    expect(
      policy.evaluate(
        plan([
          file("/synthetic/project/item", "volume-b:file-1", [
            { path: "/synthetic/project", identity: "volume-b:node-7" },
          ]),
        ]),
        settings(),
      ).kind,
    ).toBe("ask");
    expect(
      policy.evaluate(
        plan([file("/synthetic/project", "volume-b:node-7", [])]),
        settings(),
      ).kind,
    ).toBe("ask");
    const other = settings();
    other.readRules[0].conversationId = "conversation-b";
    expect(
      policy.evaluate(plan([file("/synthetic/project/item")]), other).kind,
    ).toBe("ask");
  });
  test("read permission does not imply write, and unknown MCP calls cannot receive task scope", () => {
    const write = {
      ...file("/synthetic/project/item"),
      kind: "file.modify" as const,
    };
    expect(policy.evaluate(plan([write]), settings())).toEqual({
      kind: "ask",
      scopes: ["once"],
    });
    const mcp: OperationEffect = {
      kind: "mcp.call",
      serverId: "test-server",
      generation: "generation-1",
      definitionHash: "a".repeat(64),
      argumentsHash: "b".repeat(64),
    };
    expect(policy.evaluate(plan([mcp]), settings())).toEqual({
      kind: "ask",
      scopes: ["once"],
    });
  });
  test("unavailable execution and file adapters cannot be enabled through approval", () => {
    const unsupported = settings();
    unsupported.backends = { vm: false, hostSrt: false };
    unsupported.fileBoundary = false;
    expect(
      policy.evaluate(plan([file("/synthetic/project/item")]), unsupported),
    ).toEqual({ kind: "deny", code: "CAPABILITY_UNSUPPORTED" });
    expect(
      policy.evaluate(
        plan([
          { kind: "process.execute", target: "vm", workspaceId: "work-a" },
        ]),
        unsupported,
      ).kind,
    ).toBe("deny");
    expect(
      policy.evaluate(
        plan(
          [
            {
              kind: "mcp.start",
              serverId: "test-server",
              generation: "g1",
              definitionHash: "a".repeat(64),
              argumentsHash: "b".repeat(64),
            },
          ],
          "host-srt",
        ),
        unsupported,
      ).kind,
    ).toBe("deny");
    expect(
      policy.evaluate(
        plan([
          {
            kind: "process.execute",
            target: "host-srt",
            workspaceId: "work-a",
          },
        ]),
        settings(),
      ).kind,
    ).toBe("deny");
  });
  test("normalizes hostnames and requires a canonical exact host plus an allowed port", () => {
    expect(networkHost("Example.TEST.")).toBe("example.test");
    for (const host of [
      "127.0.0.1",
      "127.0.0.1.",
      "2130706433",
      "0x7f000001",
      "[::1]",
      "example.test/path",
      "*.example.test",
      "example.test:443",
      " example.test",
      "user@example.test",
      "example..test",
    ])
      expect(networkHost(host)).toBeUndefined();
    for (const [host, port] of [
      ["Example.test", 443],
      ["example.test", 22],
      ["127.0.0.1", 443],
    ] as const)
      expect(
        policy.evaluate(
          plan([{ kind: "network.connect", host, port }]),
          settings(),
        ).kind,
      ).toBe("deny");
    expect(
      policy.evaluate(
        plan([{ kind: "network.connect", host: "example.test", port: 443 }]),
        settings(),
      ),
    ).toEqual({ kind: "ask", scopes: ["once", "task"] });
  });
});
