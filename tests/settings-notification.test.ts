import { expect, test } from "vitest";
import {
  settingsErrorDescription,
  settingsFailure,
} from "../src/renderer/src/components/worklens/settings-notification";
import {
  connectorFailure,
  connectorSuccess,
} from "../src/renderer/src/components/worklens/connectors/connector-notification";

test.each([
  [
    "Jev is busy. Try again later.",
    "Jev is busy. Try again later.",
    "Jev 暂时繁忙，请稍后重试。",
  ],
  [
    "Jira 要求稍后重试",
    "Too many requests. Try again later.",
    "请求过于频繁，请稍后重试。",
  ],
  [
    "Confluence 要求稍后重试",
    "Too many requests. Try again later.",
    "请求过于频繁，请稍后重试。",
  ],
  [
    "Tavily 要求稍后重试",
    "Too many requests. Try again later.",
    "请求过于频繁，请稍后重试。",
  ],
  [
    "Jira 网络请求失败或超时",
    "Check your network and site URL.",
    "请检查网络和网站地址。",
  ],
  [
    "Error invoking remote method 'worklens': Error: MCP error -32000: Confluence 站点证书验证失败，请求未发送。请核对站点地址，或在系统中信任该站点证书。",
    "The site certificate couldn’t be verified. Check the site URL, or trust the site’s certificate on this computer.",
    "无法验证网站证书。请核对网站地址，或在本机信任该网站证书。",
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
  [
    "Error: Error invoking remote method 'worklens': Error: Error: Sign in to this MCP server first",
    "Sign in to this MCP connection, then try again.",
    "请先登录此 MCP 连接，再重试。",
  ],
  [
    "Sign in to the selected provider first",
    "Sign in to the selected provider in Providers settings, then try again.",
    "请先在供应商设置中登录所选供应商，再重试。",
  ],
  [
    "Invalid MCP configuration. Check server names, transports and fields.",
    "Check the MCP connection names, connection types and configuration fields.",
    "请检查 MCP 连接名称、连接类型和配置字段。",
  ],
  [
    "Re-enter credentials after changing the server",
    "Re-enter the saved credentials for this connection, then try again.",
    "请重新填写此连接的已保存凭据，再重试。",
  ],
  [
    "Re-enter the OAuth client secret",
    "Re-enter the saved credentials for this connection, then try again.",
    "请重新填写此连接的已保存凭据，再重试。",
  ],
])("settings localize and shorten %s", (message, en, zh) => {
  expect(settingsErrorDescription(message, "en")).toBe(en);
  expect(settingsErrorDescription(message, "zh")).toBe(zh);
});

test("unknown errors retain useful reasons without IPC, stacks or serialized payloads", () => {
  expect(
    settingsErrorDescription(
      "Error: Error invoking remote method 'test': Error: Error: Account suspended\n    at internal.js:1",
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

test("OAuth registration rejection has a concise reason without blaming account credentials", () => {
  const message =
    "Error: OAuthRegistrationError: OAuth dynamic client registration failed with status 403: Forbidden";
  expect(settingsErrorDescription(message, "en")).toBe(
    "The service rejected this app’s registration. Check its supported apps.",
  );
  expect(settingsErrorDescription(message, "zh")).toBe(
    "服务拒绝了此应用的注册，请查看它支持的应用。",
  );
  expect(
    settingsFailure(
      "Couldn’t sign in",
      "UnknownError: " + "raw details ".repeat(100),
      "en",
      false,
      "Check the service’s setup guide and try again.",
    ),
  ).toMatchObject({
    title: "Couldn’t sign in",
    description: "Check the service’s setup guide and try again.",
    timeout: 0,
  });
});
