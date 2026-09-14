import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next, useTranslation } from "react-i18next";
import en from "./locales/en";
import zhCN from "./locales/zh-CN";

export const supportedLanguages = ["en", "zh"] as const;
export type AppLanguage = (typeof supportedLanguages)[number];

export function normalizeLanguage(language?: string): AppLanguage {
  return language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function languageTag(language: AppLanguage): "en" | "zh-CN" {
  return language === "zh" ? "zh-CN" : "en";
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      zh: { translation: zhCN },
    },
    supportedLngs: supportedLanguages,
    fallbackLng: "en",
    load: "languageOnly",
    initAsync: false,
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage"],
      caches: ["localStorage"],
      lookupLocalStorage: "worklens.language",
      convertDetectedLanguage: normalizeLanguage,
    },
  });

function updateDocumentLanguage(language: string) {
  if (typeof document !== "undefined")
    document.documentElement.lang = languageTag(normalizeLanguage(language));
}

updateDocumentLanguage(i18n.resolvedLanguage ?? i18n.language);
i18n.on("languageChanged", updateDocumentLanguage);

export function useAppTranslation() {
  const translation = useTranslation();
  return {
    ...translation,
    language: normalizeLanguage(
      translation.i18n.resolvedLanguage ?? translation.i18n.language,
    ),
  };
}

export default i18n;
