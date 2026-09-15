import i18n, { type AppLanguage } from "../../../i18n";
import { settingsFailure } from "../settings-notification";

export function connectorFailure(
  message: string,
  service: string,
  action: "test" | "save" | "remove",
  language: AppLanguage,
) {
  const t = i18n.getFixedT(language);
  return settingsFailure(
    t(`connectors.notice.${action}Failed`, { service }),
    message,
    language,
    true,
  );
}

export function connectorSuccess(
  result: string,
  service: string,
  language: AppLanguage,
) {
  const t = i18n.getFixedT(language);
  // Remove only our own result prefix, preserving account names and site addresses.
  const description = result.replace(
    /^(?:(?:Jira|Confluence|GitHub) )?(?:已连接：|Connected: )/,
    "",
  );
  return {
    type: "success" as const,
    timeout: 3200,
    title: t("connectors.notice.connected", { service }),
    description,
  };
}
