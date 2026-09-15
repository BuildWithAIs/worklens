import { expect, test } from "vitest";
import { settingsErrorDescription } from "../src/renderer/src/components/worklens/settings-notification";
import {
  connectorFailure,
  connectorSuccess,
} from "../src/renderer/src/components/worklens/connectors/connector-notification";

test.each([
  [
    "Jira 网络请求失败或超时",
    "Check your network and site URL.",
    "请检查网络和网站地址。",
  ],
  [
    "GitHub 返回 403。",
    "Check your account or token permissions.",
    "请检查账户或 Token 权限。",
  ],
  [
    "供应商限流，请稍后重试",
    "Too many requests. Try again later.",
    "请求过于频繁，请稍后重试。",
  ],
  [
    "Cloud ID 与站点 URL 不匹配",
    "Cloud ID doesn’t match this site.",
    "Cloud ID 与此网站不匹配。",
  ],
  [
    "模型或部署不可用，请检查模型和部署映射",
    "Check the model or deployment settings.",
    "请检查模型或部署设置。",
  ],
])("settings localize and shorten %s", (message, en, zh) => {
  expect(settingsErrorDescription(message, "en")).toBe(en);
  expect(settingsErrorDescription(message, "zh")).toBe(zh);
});

test("unknown errors retain useful reasons without IPC, stacks or serialized payloads", () => {
  expect(
    settingsErrorDescription(
      "Error invoking remote method 'test': Error: Account suspended\n    at internal.js:1",
      "en",
    ),
  ).toBe("Account suspended");
  expect(
    settingsErrorDescription('{"error":{"message":"Account suspended"}}', "en"),
  ).toBe("Account suspended");
  expect(
    settingsErrorDescription('[{"code":"too_small"}]', "en"),
  ).not.toContain("too_small");
});

test("connector notifications use consistent lifetimes and preserve account information", () => {
  expect(
    connectorFailure("Jira 返回 401。", "Jira", "save", "en"),
  ).toMatchObject({
    title: "Couldn’t complete Jira setup",
    description: "Check your token and account.",
    timeout: 0,
  });
  expect(
    connectorSuccess("已连接：张三 · https://example.test", "Jira", "zh"),
  ).toMatchObject({
    title: "已连接 Jira",
    description: "张三 · https://example.test",
    timeout: 3200,
  });
});
