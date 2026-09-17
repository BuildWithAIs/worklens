import { regexes } from "zod/v4/core";
import type { useAppTranslation } from "@/i18n";

export type Values = {
  url: string;
  token?: string;
  deployment?: string;
  email?: string;
  tokenType?: string;
  cloudId?: string;
};
export type Connection = Omit<Values, "token"> & {
  configured: boolean;
  error?: string;
};
export type FieldName = "url" | "token" | "email" | "cloudId";
export const fields: FieldName[] = ["url", "email", "cloudId", "token"];

function site(value: string, github: boolean) {
  try {
    const url = new URL(value.trim());
    return github ? url.origin : url.href.replace(/\/+$/, "");
  } catch {
    return value.trim();
  }
}

// Pure form evaluation: preserve service-specific requirements and saved-token rules.
export function evaluateConnectorForm(
  service: string,
  form: Values,
  connection: Connection | undefined,
  t: ReturnType<typeof useAppTranslation>["t"],
) {
  const github = service === "github";
  const cloud = form.deployment === "cloud";
  const optional = (value?: string) => value?.trim() || undefined;
  // A retained configuration can contain a saved token even when its last test failed.
  // The main process remains authoritative about whether credentials can be reused.
  const canReuseToken =
    !!connection?.url &&
    site(form.url, github) === site(connection.url, github) &&
    (github ||
      (form.deployment === connection.deployment &&
        optional(form.email) === optional(connection.email) &&
        form.tokenType === connection.tokenType &&
        (optional(form.cloudId) === optional(connection.cloudId) ||
          (service === "jira" &&
            cloud &&
            form.tokenType === "scoped" &&
            !optional(form.cloudId)))));
  const needsCloudId =
    service === "confluence" && cloud && form.tokenType === "scoped";
  const errors: Partial<Record<FieldName, string>> = {};
  const required = (field: FieldName) =>
    t("connectors.form.required", {
      field: t(`connectors.form.fields.${field}`),
    });
  const invalid = (field: FieldName) =>
    t(
      {
        url: "settingsFeedback.url",
        email: "settingsFeedback.email",
        token: "settingsFeedback.tokenInvalid",
        cloudId: "settingsFeedback.cloudIdInvalid",
      }[field] as
        | "settingsFeedback.url"
        | "settingsFeedback.email"
        | "settingsFeedback.tokenInvalid"
        | "settingsFeedback.cloudIdInvalid",
    );
  if (!form.url.trim()) errors.url = required("url");
  else {
    try {
      const url = new URL(form.url.trim());
      if (
        !/^https?:$/.test(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (github && !/^\/*$/.test(url.pathname))
      )
        errors.url = t(
          github ? "settingsFeedback.githubUrl" : "settingsFeedback.url",
        );
      else if (
        (cloud ||
          (github &&
            (url.hostname === "github.com" ||
              url.hostname.endsWith(".ghe.com")))) &&
        (url.protocol !== "https:" || (github && !!url.port))
      )
        errors.url = t("settingsFeedback.https");
    } catch {
      errors.url = t("settingsFeedback.url");
    }
  }
  if (form.url.trim().length > 2000) errors.url = invalid("url");
  if (cloud && !optional(form.email)) errors.email = required("email");
  else if (cloud && !regexes.email.test(form.email?.trim() ?? ""))
    errors.email = t("settingsFeedback.email");
  if (needsCloudId && !optional(form.cloudId))
    errors.cloudId = required("cloudId");
  else if (form.cloudId && !/^[a-zA-Z0-9-]{0,100}$/.test(form.cloudId.trim()))
    errors.cloudId = t("settingsFeedback.cloudIdInvalid");
  if (!optional(form.token) && !canReuseToken) errors.token = required("token");
  if ((form.token?.trim().length ?? 0) > 20000)
    errors.token = t("settingsFeedback.tokenInvalid");
  const missing =
    !form.url.trim() ||
    (cloud && !optional(form.email)) ||
    (needsCloudId && !optional(form.cloudId)) ||
    (!optional(form.token) && !canReuseToken);
  // Equivalent valid values need no save. Invalid edits must remain actionable
  // so explicit validation can explain the error (for example a GitHub path).
  // A connection whose last validation failed can still be re-saved as a retry.
  const unchanged =
    canReuseToken &&
    !optional(form.token) &&
    !connection?.error &&
    Object.keys(errors).length === 0;
  return {
    canReuseToken,
    cloud,
    needsCloudId,
    errors,
    missing,
    unchanged,
    required,
    invalid,
  };
}
