import type { GlobalUsage, TokenUsage } from "./contracts";

export function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function unavailableUsage(): TokenUsage {
  return {
    status: "unavailable",
    cost: { status: "unavailable", source: "unknown" },
  };
}

/** Bootstrap and chat events use the same guard, independently of run sequence. */
export function newerGlobalUsage(
  current?: GlobalUsage,
  incoming?: GlobalUsage,
): GlobalUsage | undefined {
  return incoming && (!current || incoming.revision >= current.revision)
    ? incoming
    : current;
}
