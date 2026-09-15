import type en from "../../i18n/locales/en";
import i18n, { type AppLanguage } from "../../i18n";
import { systemText } from "../../lib/system-text";

// Presentation mapping for settings only; shared runtime/tool messages stay intact.
export function settingsErrorDescription(
  message: string,
  language: AppLanguage,
  token = false,
) {
  const t = i18n.getFixedT(language);
  const clean = message
    .replace(/^Error:\s*/, "")
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
  const english = systemText(clean, "en");
  const patterns: [RegExp, keyof typeof en.settingsFeedback][] = [
    [/read or decrypt|Unrecognized credential/i, "unreadable"],
    [/secure storage/i, "secureStorage"],
    [
      /returned HTTP 401|Authentication failed|did not return a (signed-in user|valid authenticated account)/i,
      token ? "token" : "credentials",
    ],
    [/returned HTTP 403/i, "permissions"],
    [/rate limit|returned HTTP 429/i, "rateLimit"],
    [/Cloud ID does not match/i, "cloudId"],
    [/discover the Cloud ID/i, "cloudIdDiscover"],
    [/verify the Cloud ID/i, "cloudIdVerify"],
    [/unreadable response/i, "response"],
    [/redirect/i, "redirect"],
    [/without credentials, query parameters or a fragment/i, "url"],
    [/requires.*HTTPS|endpoint must use HTTPS/i, "https"],
    [
      /Could not reach|timed out|Connection timed out|Network or service request failed/i,
      "network",
    ],
    [/Model or deployment unavailable/i, "model"],
    [/Invalid service endpoint/i, "endpoint"],
    [/authentication step has expired/i, "expired"],
    [/Could not refresh models/i, "refresh"],
  ];
  const key = patterns.find(([pattern]) => pattern.test(english))?.[1];
  if (key) return t(`settingsFeedback.${key}`);
  // Preserve useful upstream reasons without displaying serialized exceptions/stacks.
  if (/^[\[{]/.test(clean)) {
    try {
      const parsed = JSON.parse(clean);
      const reason = parsed?.error?.message ?? parsed?.message;
      if (typeof reason === "string" && reason !== clean)
        return settingsErrorDescription(reason, language, token);
    } catch {
      /* malformed serialized error */
    }
    return t("settingsFeedback.unknown");
  }
  return (
    systemText(clean.split(/\n\s*at /)[0], language) ||
    t("settingsFeedback.unknown")
  );
}

// Shared presentation policy; callers keep their operation-specific titles.
export function settingsFailure(
  title: string,
  message: string,
  language: AppLanguage,
  token = false,
) {
  return {
    type: "error" as const,
    timeout: 0,
    priority: "high" as const,
    title,
    description: settingsErrorDescription(message, language, token),
  };
}
