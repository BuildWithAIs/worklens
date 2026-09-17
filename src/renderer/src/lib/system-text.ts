import i18n, { type AppLanguage } from "../i18n";

// Main-process and provider messages are untrusted runtime data. Translate only
// known application-owned text and leave conversation/tool content untouched.
const messages = [
  [
    "该技能未启用或已不存在，请在设置中检查技能",
    "This skill is disabled or no longer available. Check Skills in Settings.",
    "skills.unavailable",
  ],
  [
    "Cloud 需要 HTTPS 地址",
    "Cloud requires an HTTPS address.",
    "connectors.runtime.cloudHttps",
  ],
  [
    "GitHub Cloud 需要标准 HTTPS 站点地址",
    "GitHub Cloud requires a standard HTTPS site address.",
    "connectors.runtime.githubHttps",
  ],
  [
    "Cloud 需要 Atlassian 账户邮箱",
    "Enter your Atlassian account email for Cloud.",
    "connectors.runtime.cloudEmail",
  ],
  [
    "Scoped token 需要站点 Cloud ID",
    "Enter the site Cloud ID for a scoped token.",
    "connectors.runtime.cloudIdRequired",
  ],
  [
    "无法自动获取 Cloud ID，请手工填写",
    "Could not discover the Cloud ID. Enter it manually.",
    "connectors.runtime.cloudIdDiscover",
  ],
  [
    "无法验证站点 URL 对应的 Cloud ID",
    "Could not verify the Cloud ID for this site address.",
    "connectors.runtime.cloudIdVerify",
  ],
  [
    "Cloud ID 与站点 URL 不匹配",
    "The Cloud ID does not match the site address.",
    "connectors.runtime.cloudIdMismatch",
  ],
  [
    "请填写 token；更换站点或账户后需要重新填写",
    "Enter a token. A new token is required after changing the site or account.",
    "connectors.runtime.tokenRequired",
  ],
  [
    "请填写 token；更换站点后需要重新填写",
    "Enter a token. A new token is required after changing the site.",
    "connectors.runtime.githubTokenRequired",
  ],
  [
    "服务未返回已登录用户，请检查 token 和认证方式",
    "The service did not return a signed-in user. Check the token and authentication method.",
    "connectors.runtime.userMissing",
  ],
  [
    "GitHub 未返回有效的认证账号",
    "GitHub did not return a valid authenticated account.",
    "connectors.runtime.githubUserMissing",
  ],
  [
    "检测到重定向，请检查站点地址及 API 认证，不能使用网页登录地址。",
    "A redirect was detected. Check the site address and API authentication; do not use a sign-in page URL.",
    "connectors.runtime.redirect",
  ],
  [
    "请检查目标、部署类型、token 和权限。",
    "Check the target, deployment type, token and permissions.",
    "connectors.runtime.checkAccess",
  ],
  [
    "服务未返回可用的 JSON（可能是 SSO 登录页面或响应过大）",
    "The service returned an unreadable response. Check whether the address redirects to an SSO sign-in page or the response is too large.",
    "connectors.runtime.invalidJson",
  ],
  [
    "GitHub 要求稍后重试",
    "GitHub is rate limiting requests. Try again later.",
    "connectors.runtime.rateLimit",
  ],
  [
    "GitHub API 返回重定向，请检查站点地址和目标；未转发凭据",
    "GitHub redirected the API request. Check the site address and target. Credentials were not forwarded.",
    "connectors.runtime.githubRedirect",
  ],
  ["已连接：", "Connected: ", "connectors.runtime.connectedPrefix"],
  [
    "运行期间不能切换模型",
    "Can’t switch models while responding.",
    "system.cantSwitchModels",
  ],
  [
    "当前会话正在运行，请先停止",
    "Stop the current response before continuing.",
    "system.stopCurrentResponse",
  ],
  [
    "模型尚未配置或不可用，请在设置中完成认证",
    "Connect a provider in Settings to use this model.",
    "system.connectProvider",
  ],
  [
    "模型已不在 Pi 目录中，请重新选择",
    "This model is no longer available. Select another model.",
    "system.modelRemoved",
  ],
  [
    "此模型不支持所选推理等级",
    "This model does not support the selected reasoning level.",
    "system.unsupportedReasoning",
  ],
  ["模型请求失败", "The model request failed.", "system.modelRequestFailed"],
  ["应用正在退出", "The app is closing.", "system.appClosing"],
  [
    "会话不存在或 Pi 无法识别该文件",
    "This conversation could not be opened.",
    "system.conversationCouldNotBeOpened",
  ],
  [
    "会话标识不匹配",
    "The conversation ID does not match.",
    "system.conversationIdMismatch",
  ],
  [
    "会话文件标识不匹配",
    "The conversation file ID does not match.",
    "system.conversationFileIdMismatch",
  ],
  [
    "拒绝删除专属会话目录之外的文件",
    "Files outside the conversation folder cannot be deleted.",
    "system.outsideConversationDelete",
  ],
  [
    "恢复记录不存在",
    "The recovery record could not be found.",
    "system.recoveryMissing",
  ],
  [
    "有一份运行恢复记录无法读取，原文件已保留。",
    "A recovery record could not be read. The original file is preserved.",
    "system.recoveryUnreadable",
  ],
  ["消息不能为空", "Enter a message to continue.", "system.enterMessage"],
  [
    "只允许打开 HTTP 或 HTTPS 网页链接",
    "Only HTTP or HTTPS links can be opened.",
    "system.onlyHttpLinks",
  ],
  [
    "不受信任的调用来源",
    "This request came from an untrusted source.",
    "system.untrustedSource",
  ],
  ["未知请求", "Unknown request.", "system.unknownRequest"],
  ["操作失败", "The operation failed.", "system.operationFailed"],
  ["未知供应商", "Unknown provider.", "system.unknownProvider"],
  ["模型目录已刷新并缓存", "Models refreshed.", "system.modelsRefreshed"],
  [
    "Azure 地址必须使用 HTTPS",
    "The Azure endpoint must use HTTPS.",
    "system.azureHttps",
  ],
  ["模型不存在", "Model not found.", "system.modelNotFound"],
  [
    "连接成功：",
    "Connection successful: ",
    "system.connectionSuccessfulPrefix",
  ],
  [
    "凭据格式无法识别",
    "Unrecognized credential format.",
    "system.unrecognizedCredentialFormat",
  ],
  [
    "凭据内容无法识别",
    "Unrecognized credential content.",
    "system.unrecognizedCredentialContent",
  ],
  [
    "操作系统安全存储不可用，无法保存凭据",
    "Credentials could not be saved because secure storage is unavailable.",
    "system.secureStorageUnavailable",
  ],
  [
    "应用设置版本不受支持",
    "This settings version is not supported.",
    "system.unsupportedSettingsVersion",
  ],
  [
    "Azure 配置需要接口密钥认证",
    "Azure configuration requires API key authentication.",
    "system.azureRequiresApiKey",
  ],
  [
    "在浏览器中输入设备码完成登录",
    "Enter the device code in your browser to sign in.",
    "system.enterDeviceCode",
  ],
  [
    "认证已完成，凭据已加密保存",
    "Signed in. Credentials saved securely.",
    "system.authComplete",
  ],
  ["认证已取消", "Authentication cancelled.", "system.authCancelled"],
  ["认证已结束", "Authentication ended.", "system.authEnded"],
  [
    "认证已在进行",
    "Authentication is already in progress.",
    "system.authInProgress",
  ],
  [
    "认证步骤已过期",
    "This authentication step has expired. Please try again.",
    "system.authExpired",
  ],
  [
    "模型目录刷新未完成，已保留缓存目录，请稍后重试",
    "Could not refresh models. The cached catalog is retained. Please try again.",
    "system.modelRefreshFailed",
  ],
  [
    "认证失败，请重新配置凭据",
    "Authentication failed. Update your credentials.",
    "system.authFailed",
  ],
  [
    "供应商限流，请稍后重试",
    "Rate limited by the provider. Please try again later.",
    "system.rateLimited",
  ],
  [
    "连接超时，请检查网络或服务地址",
    "Connection timed out. Check your network or endpoint.",
    "system.connectionTimeout",
  ],
  [
    "模型或部署不可用，请检查模型和部署映射",
    "Model or deployment unavailable. Check the deployment mapping.",
    "system.modelUnavailable",
  ],
  ["服务端点配置错误", "Invalid service endpoint.", "system.invalidEndpoint"],
  [
    "网络或服务请求失败",
    "Network or service request failed.",
    "system.networkFailed",
  ],
  [
    "无法读取或解密已保存的凭据，请重新配置或移除凭据。原文件尚未修改。",
    "Saved credentials could not be read or decrypted. Update or remove them. The original file is unchanged.",
    "system.savedCredentialsUnreadable",
  ],
] as const;

export function systemText(text: string, language: AppLanguage) {
  const t = i18n.getFixedT(language);
  let result = text
    .replaceAll("[redacted]", t("system.redacted"))
    .replaceAll("[已隐藏]", t("system.redacted"));

  // Connector-owned runtime messages carry service names and status codes.
  // Translate their known wording while retaining server-provided details.
  result = result
    .replace(
      /(Jira|Confluence|GitHub|Tavily) 网络请求失败或超时/g,
      (_, service) => t("connectors.runtime.network", { service }),
    )
    .replace(
      /(Jira|Confluence|GitHub|Tavily) 返回 (\d{3})。/g,
      (_, service, status) =>
        t("connectors.runtime.httpStatus", { service, status }),
    )
    .replace(
      /无法读取或解密 (Jira|Confluence|GitHub|Tavily) 配置，原文件已保留。请重新填写 token 或断开连接。/g,
      (_, service) =>
        t("connectors.runtime.credentialsUnreadable", { service }),
    )
    .replace(
      /请先在设置 → 连接中保存并验证 (Jira|Confluence|GitHub|Tavily) 连接/g,
      (_, service) => t("connectors.runtime.connectFirst", { service }),
    )
    .replace(
      /(Jira|Confluence|GitHub|Tavily) 连接已变更，请重新读取目标/g,
      (_, service) => t("connectors.runtime.changed", { service }),
    )
    .replace(
      /请输入不含凭据、查询参数或片段的 (Jira|Confluence) 站点地址/g,
      (_, service) => t("connectors.runtime.siteInvalid", { service }),
    );

  for (const [chinese, english, key] of messages) {
    result = result.replaceAll(chinese, t(key)).replaceAll(english, t(key));
  }

  return result
    .replace(
      /第 (\d+)\/(\d+) 次重试，等待 (\d+) 秒/g,
      (_, current, total, seconds) =>
        t("system.retry", {
          current: Number(current),
          total: Number(total),
          seconds: Number(seconds),
        }),
    )
    .replace(/会话 (.+?) 无法打开：/g, (_, id) =>
      t("system.conversationOpenFailed", { id }),
    )
    .replace(
      /上次退出时有 (\d+) 个运行未完成。已保留中断记录；工具可能产生了副作用，请核对后继续。/g,
      (_, count) => t("system.interruptedTasks", { count: Number(count) }),
    );
}
