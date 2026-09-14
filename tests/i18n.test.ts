import { afterEach, describe, expect, test } from "vitest";
import i18n, { languageTag, normalizeLanguage } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/locales/en";
import zhCN from "../src/renderer/src/i18n/locales/zh-CN";
import { systemText } from "../src/renderer/src/lib/system-text";

function leafKeys(value: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === "object"
      ? leafKeys(child as Record<string, unknown>, path)
      : [path];
  });
}

afterEach(() => i18n.changeLanguage("en"));

describe("internationalization resources", () => {
  test("English and Simplified Chinese expose the same complete key set", () => {
    expect(leafKeys(zhCN).sort()).toEqual(leafKeys(en).sort());
    expect(leafKeys(en).length).toBeGreaterThan(250);
  });

  test("normalizes detected locales and formats document language tags", () => {
    expect(normalizeLanguage("zh-CN")).toBe("zh");
    expect(normalizeLanguage("zh-Hans-US")).toBe("zh");
    expect(normalizeLanguage("en-GB")).toBe("en");
    expect(normalizeLanguage(undefined)).toBe("en");
    expect(languageTag("zh")).toBe("zh-CN");
    expect(languageTag("en")).toBe("en");
  });

  test("switches resources and interpolates values through i18next", async () => {
    await i18n.changeLanguage("zh");
    expect(i18n.t("app.conversationOptions", { title: "周报" })).toBe(
      "会话选项：周报",
    );
    expect(i18n.t("thread.doAnything")).toBe("输入你想做的事…");

    await i18n.changeLanguage("en");
    expect(i18n.t("app.conversationOptions", { title: "Weekly report" })).toBe(
      "Conversation options: Weekly report",
    );
  });

  test("translates known main-process messages without rewriting unknown content", () => {
    expect(systemText("模型尚未配置或不可用，请在设置中完成认证", "en")).toBe(
      "Connect a provider in Settings to use this model.",
    );
    expect(systemText("Retry failed [redacted]", "zh")).toBe(
      "Retry failed [已隐藏]",
    );
    expect(systemText("用户原始内容", "en")).toBe("用户原始内容");
  });
});
