import { nonNegative } from "../../../shared/usage";
export function formatTokens(value?: number): string {
  if (!nonNegative(value)) return "—";
  if (value >= 1e9) return `${Number((value / 1e9).toFixed(2))}B`;
  if (value >= 1e6) return `${Number((value / 1e6).toFixed(2))}M`;
  if (value >= 1e3) return `${Number((value / 1e3).toFixed(1))}k`;
  return Math.round(value).toString();
}
export function formatCost(value?: number, detailed = false): string {
  if (!nonNegative(value)) return "—";
  if (value > 0 && value < 0.001) return "<$0.001";
  return `$${value.toFixed(detailed || (value > 0 && value < 0.01) ? 3 : 2)}`;
}
