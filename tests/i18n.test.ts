import { afterEach, describe, expect, test } from "vitest";
import i18n, { languageTag, normalizeLanguage } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/locales/en";
import zhCN from "../src/renderer/src/i18n/locales/zh-CN";
import {
  imageFileError,
  systemText,
} from "../src/renderer/src/lib/system-text";

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

  test("per-file image errors separate the file name from a short reason", () => {
    const name = encodeURIComponent("Long screenshot.png");
    expect(
      imageFileError(`Error: CHAT_IMAGE_DIMENSIONS 12000x9000 ${name}`, "en"),
    ).toEqual({
      name: "Long screenshot.png",
      message:
        "12,000 × 9,000 pixels is too large. Resize it to fit within 10,000 × 10,000.",
    });
    expect(imageFileError(`CHAT_IMAGE_SIZE ${name}`, "zh")).toEqual({
      name: "Long screenshot.png",
      message: "超过 20 MiB，请选择更小的图片。",
    });
    // Plain-text surfaces keep both parts on one line.
    expect(systemText(`CHAT_IMAGE_DIMENSIONS 12000x9000 ${name}`, "zh")).toBe(
      "Long screenshot.png：12000 × 9000 像素过大，请缩小到 10000 × 10000 以内。",
    );
    expect(imageFileError("CHAT_IMAGE_SIZE", "en")).toBeUndefined();
    expect(systemText("CHAT_IMAGE_SIZE", "en")).toBe(
      "Each image must be 20 MiB or smaller.",
    );
    // Without a file this comes from sending conversation history.
    expect(systemText("CHAT_IMAGE_DIMENSIONS", "en")).toBe(
      "Couldn’t send an image because it’s too large. Try again.",
    );
  });
});

for (const service of ["Jira", "Confluence", "GitHub", "Tavily"]) {
  test(`${service} runtime failures follow the selected language`, () => {
    expect(systemText(`${service} 要求稍后重试`, "en")).toBe(
      `${service} is rate limiting requests. Try again later.`,
    );
    expect(systemText(`${service} 网络请求失败或超时`, "en")).toBe(
      `Couldn’t reach ${service} or the request timed out. Check your network and site address, then try again.`,
    );
    expect(systemText(`${service} 网络请求失败或超时`, "zh")).toContain(
      `无法连接 ${service}`,
    );
    expect(
      systemText(
        `${service} 站点证书验证失败，请求未发送。请核对站点地址，或在系统中信任该站点证书。`,
        "en",
      ),
    ).toBe(
      `${service} couldn’t verify the site certificate, so the request wasn’t sent. Check the site address, or trust the site’s certificate on this computer.`,
    );
    expect(
      systemText(
        `${service} 返回 401。请检查目标、部署类型、token 和权限。`,
        "en",
      ),
    ).toBe(
      `${service} returned HTTP 401. Check the target, deployment type, token and permissions.`,
    );
  });
}

test("connector result translation preserves account names, URLs and unknown details", () => {
  expect(
    systemText("已连接：张三 · https://wiki.example.test/wiki", "en"),
  ).toBe("Connected: 张三 · https://wiki.example.test/wiki");
  expect(systemText("Cloud ID 与站点 URL 不匹配", "en")).toBe(
    "The Cloud ID does not match the site address.",
  );
  expect(systemText("upstream detail: 仓库暂时不可用", "en")).toBe(
    "upstream detail: 仓库暂时不可用",
  );
});

test("image validation messages use the selected language", () => {
  expect(systemText("CHAT_IMAGE_INVALID", "en")).toBe(
    "Couldn’t read this image. Try exporting it as PNG or JPEG.",
  );
  expect(systemText("CHAT_IMAGE_MODEL", "zh")).toBe("请选择支持图片的模型。");
});
