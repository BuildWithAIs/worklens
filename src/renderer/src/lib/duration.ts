import type { AppLanguage } from "@/i18n";

/**
 * Readable elapsed time: "47s", "4m 35s", "1h 2m" ("4分35秒" in Chinese).
 * `precise` adds tenths below 10 seconds and "<1s", for short tool calls.
 */
export function formatDuration(
  ms: number,
  language: AppLanguage,
  precise = false,
): string {
  const zh = language === "zh";
  if (precise && ms < 1000) return zh ? "<1秒" : "<1s";
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) {
    const value =
      precise && seconds < 10
        ? (Math.floor(seconds * 10) / 10).toFixed(1)
        : String(Math.floor(seconds));
    return zh ? `${value}秒` : `${value}s`;
  }
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.floor(seconds % 60);
    return zh ? `${minutes}分${rest}秒` : `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return zh ? `${hours}小时${minutes}分` : `${hours}h ${minutes}m`;
}
