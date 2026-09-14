import i18n, { type AppLanguage } from "../i18n";

// Main-process and provider messages are untrusted runtime data. Translate only
// known application-owned text and leave conversation/tool content untouched.
const messages = [
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
