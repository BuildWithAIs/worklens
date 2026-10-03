import type { TavilyUsage } from "../../../shared/contracts";

const creditCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

/** Account credits only: a key's separate cap is not the account's balance. */
export function accountUsage(value: unknown): TavilyUsage {
  const account = (value as { account?: unknown } | null)?.account;
  if (!account || typeof account !== "object" || Array.isArray(account))
    throw new Error("TAVILY_USAGE_UNAVAILABLE");
  const fields = account as Record<string, unknown>;
  const paygo = {
    used: creditCount(fields.paygo_usage),
    limit: creditCount(fields.paygo_limit),
  };
  return {
    plan:
      typeof fields.current_plan === "string" ? fields.current_plan : undefined,
    included: {
      used: creditCount(fields.plan_usage),
      limit: creditCount(fields.plan_limit),
    },
    // Zero or absent pay-as-you-go fields do not add an empty second row.
    ...((paygo.used ?? 0) > 0 || (paygo.limit ?? 0) > 0 ? { paygo } : {}),
  };
}
