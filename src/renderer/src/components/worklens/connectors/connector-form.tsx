import {
  evaluateConnectorForm,
  fields,
  type Values,
  type Connection,
  type FieldName,
} from "./connector-validation";
import { connectorName, type ConnectorAction } from "./connector-presentation";
import { useState } from "react";
import { toast } from "@/components/ui/toast";
import { useAppTranslation } from "@/i18n";
import { connectorFailure, connectorSuccess } from "./connector-notification";
import { systemText } from "@/lib/system-text";

export function useConnectorForm(
  service: string,
  form: Values,
  connection?: Connection,
) {
  const { t, language } = useAppTranslation();
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>(
    {},
  );
  const [serverErrors, setServerErrors] = useState<
    Partial<Record<FieldName, string>>
  >({});
  const {
    canReuseToken,
    cloud,
    needsCloudId,
    errors,
    missing,
    unchanged,
    required,
    invalid,
  } = evaluateConnectorForm(service, form, connection, t);
  const fieldError = (field: FieldName) =>
    serverErrors[field] || (touched[field] ? errors[field] : undefined);
  const focusError = (next: Partial<Record<FieldName, string>>) => {
    const field = fields.find((name) => next[name]);
    if (field)
      requestAnimationFrame(() => {
        document
          .getElementById(
            `${service}-${field === "cloudId" ? "cloud-id" : field}`,
          )
          ?.focus();
      });
  };
  return {
    canReuseToken,
    notifyFailure: (message: string, action: ConnectorAction) =>
      toast.add(
        connectorFailure(message, connectorName(service), action, language),
      ),
    notifyConnected: (result: string) =>
      toast.add(connectorSuccess(result, connectorName(service), language)),
    missing,
    unchanged,
    fieldError,
    reset: () => setServerErrors({}),
    props: (field: FieldName) => ({
      name: field,
      spellCheck: false,
      "aria-required":
        field === "url" ||
        (field === "token" && !canReuseToken) ||
        (field === "email" && cloud) ||
        (field === "cloudId" && needsCloudId),
      "aria-invalid": !!fieldError(field),
      "aria-describedby": fieldError(field)
        ? `${service}-${field === "cloudId" ? "cloud-id" : field}-error`
        : undefined,
    }),
    validate: () => {
      setTouched({ url: true, token: true, email: true, cloudId: true });
      focusError(errors);
      return Object.keys(errors).length === 0;
    },
    errorMessage: (error: unknown, attach = false) => {
      const message = (error instanceof Error ? error.message : String(error))
        .replace(/^Error: /, "")
        .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
      try {
        const issues: unknown = JSON.parse(message);
        if (Array.isArray(issues)) {
          const mapped: Partial<Record<FieldName, string>> = {};
          for (const issue of issues) {
            const field = issue?.path?.[0] as FieldName;
            if (fields.includes(field))
              mapped[field] =
                issue.code === "too_small" ? required(field) : invalid(field);
          }
          if (attach) {
            setServerErrors(mapped);
            focusError(mapped);
          }
          if (attach && Object.keys(mapped).length) return undefined;
          return (
            Object.values(mapped).join(" ") || t("connectors.form.checkFields")
          );
        }
        return t("connectors.form.failed");
      } catch {
        if (/^\s*[\[{]/.test(message)) return t("connectors.form.failed");
        return systemText(message, language) || t("connectors.form.failed");
      }
    },
  };
}
