import { isAbsolute, relative, resolve, sep } from "node:path";
import { domainToASCII } from "node:url";
import { isIP } from "node:net";
import type { OperationPlan, PolicyDecision, PolicySettings } from "./types";
export function atOrUnder(path: string, root: string) {
  if (
    !isAbsolute(path) ||
    !isAbsolute(root) ||
    path.includes("\0") ||
    root.includes("\0")
  )
    return false;
  const part = relative(resolve(root), resolve(path));
  return (
    part === "" ||
    (!isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep))
  );
}
export function networkHost(host: string) {
  if (host !== host.trim() || /[\s/@:*?\\]/.test(host) || isIP(host))
    return undefined;
  const name = domainToASCII(host.replace(/\.$/, "").toLowerCase());
  return name &&
    !isIP(name) &&
    name.length <= 253 &&
    name
      .split(".")
      .every((p) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))
    ? name
    : undefined;
}
export class PolicyService {
  evaluate(plan: OperationPlan, settings: PolicySettings): PolicyDecision {
    let ask = false;
    let taskScope = true;
    // Scan all hard denies before selecting Ask or Allow for any effect.
    for (const effect of plan.effects) {
      if ("target" in effect && typeof effect.target === "object") {
        const { path } = effect.target;
        if (
          !isAbsolute(path) ||
          path.includes("\0") ||
          [...settings.protectedPaths, ...settings.deniedPaths].some((root) =>
            atOrUnder(path, root),
          )
        )
          return { kind: "deny", code: "PERMISSION_DENIED" };
        if (!settings.fileBoundary)
          return { kind: "deny", code: "CAPABILITY_UNSUPPORTED" };
        if (effect.kind === "file.read" || effect.kind === "file.list") {
          const allowed = settings.readRules.some(
            (rule) =>
              rule.enabled &&
              rule.conversationId === plan.invocation.conversationId &&
              rule.actions.includes(effect.kind as "file.read" | "file.list") &&
              (rule.subtree
                ? atOrUnder(path, rule.path) &&
                  (path === rule.path
                    ? effect.target.identity === rule.identity
                    : effect.target.ancestors.some(
                        (p) =>
                          p.path === rule.path && p.identity === rule.identity,
                      ))
                : path === rule.path &&
                  effect.target.identity === rule.identity),
          );
          if (!allowed) ask = true;
        } else {
          ask = true;
          taskScope = false;
        }
      } else if (effect.kind === "network.connect") {
        if (
          networkHost(effect.host) !== effect.host ||
          ![80, 443].includes(effect.port)
        )
          return { kind: "deny", code: "PERMISSION_DENIED" };
        ask = true;
      } else if (effect.kind === "process.execute") {
        if (
          effect.target !== plan.executionTarget ||
          !(effect.target === "vm"
            ? settings.backends.vm
            : settings.backends.hostSrt)
        )
          return { kind: "deny", code: "CAPABILITY_UNSUPPORTED" };
        const binding = settings.execution;
        if (
          !binding ||
          binding.conversationId !== plan.invocation.conversationId ||
          binding.runId !== plan.invocation.runId ||
          binding.target !== effect.target ||
          binding.workspaceId !== effect.workspaceId
        )
          return { kind: "deny", code: "CAPABILITY_UNSUPPORTED" };
        taskScope = false;
      } else if (effect.kind === "mcp.start") {
        if (!settings.backends.hostSrt || plan.executionTarget !== "host-srt")
          return { kind: "deny", code: "CAPABILITY_UNSUPPORTED" };
        ask = true;
        taskScope = false;
      } else {
        ask = true;
        taskScope = false;
      }
    }
    return ask
      ? { kind: "ask", scopes: taskScope ? ["once", "task"] : ["once"] }
      : { kind: "allow" };
  }
}
