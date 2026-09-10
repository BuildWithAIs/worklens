import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

type Language = "en" | "zh";
const Locale = createContext({
  language: "en" as Language,
  setLanguage: (_: Language) => {},
  t: (en: string, _zh: string) => en,
});
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() =>
    localStorage.getItem("worklens.language") === "zh" ? "zh" : "en",
  );
  useEffect(() => {
    localStorage.setItem("worklens.language", language);
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }, [language]);
  return (
    <Locale.Provider
      value={{
        language,
        setLanguage,
        t: (en, zh) => (language === "zh" ? zh : en),
      }}
    >
      {children}
    </Locale.Provider>
  );
}
export const useLocale = () => useContext(Locale);
