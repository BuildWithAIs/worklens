// Temporary presentation bridge until backend language support is available.
// Only system-owned messages are translated; never rewrite conversation content.
const messages: Record<string, string> = {
  运行期间不能切换模型:
    "Can’t switch models while responding.",
  "当前会话正在运行，请先停止": "Stop the current response before continuing.",
  "模型尚未配置或不可用，请在设置中完成认证":
    "Connect a provider in Settings to use this model.",
  "模型已不在 Pi 目录中，请重新选择":
    "This model is no longer available. Select another model.",
  此模型不支持所选推理等级:
    "This model does not support the selected reasoning level.",
  模型请求失败: "The model request failed.",
  应用正在退出: "The app is closing.",
  "会话不存在或 Pi 无法识别该文件": "This conversation could not be opened.",
  会话标识不匹配: "The conversation ID does not match.",
  会话文件标识不匹配: "The conversation file ID does not match.",
  拒绝删除专属会话目录之外的文件:
    "Files outside the conversation folder cannot be deleted.",
  恢复记录不存在: "The recovery record could not be found.",
  "有一份运行恢复记录无法读取，原文件已保留。":
    "A recovery record could not be read. The original file is preserved.",
  消息不能为空: "Enter a message to continue.",
  "只允许打开 HTTP 或 HTTPS 网页链接":
    "Only HTTP or HTTPS links can be opened.",
  不受信任的调用来源: "This request came from an untrusted source.",
  未知请求: "Unknown request.",
  操作失败: "The operation failed.",
  未知供应商: "Unknown provider.",
  模型目录已刷新并缓存: "Models refreshed.",
  "Azure 地址必须使用 HTTPS": "The Azure endpoint must use HTTPS.",
  模型不存在: "Model not found.",
  "连接成功：": "Connection successful: ",
  凭据格式无法识别: "Unrecognized credential format.",
  凭据内容无法识别: "Unrecognized credential content.",
  "操作系统安全存储不可用，无法保存凭据":
    "Credentials could not be saved because secure storage is unavailable.",
  应用设置版本不受支持: "This settings version is not supported.",

  "Azure 配置需要接口密钥认证":
    "Azure configuration requires API key authentication.",
  在浏览器中输入设备码完成登录:
    "Enter the device code in your browser to sign in.",
  "认证已完成，凭据已加密保存": "Signed in. Credentials saved securely.",
  认证已取消: "Authentication cancelled.",
  认证已结束: "Authentication ended.",
  认证已在进行: "Authentication is already in progress.",
  认证步骤已过期: "This authentication step has expired. Please try again.",
  "模型目录刷新未完成，已保留缓存目录，请稍后重试":
    "Could not refresh models. The cached catalog is retained. Please try again.",
  "认证失败，请重新配置凭据": "Authentication failed. Update your credentials.",
  "供应商限流，请稍后重试":
    "Rate limited by the provider. Please try again later.",
  "连接超时，请检查网络或服务地址":
    "Connection timed out. Check your network or endpoint.",
  "模型或部署不可用，请检查模型和部署映射":
    "Model or deployment unavailable. Check the deployment mapping.",
  服务端点配置错误: "Invalid service endpoint.",
  网络或服务请求失败: "Network or service request failed.",
  "无法读取或解密已保存的凭据，请重新配置或移除凭据。原文件尚未修改。":
    "Saved credentials could not be read or decrypted. Update or remove them. The original file is unchanged.",
};
export function systemText(text: string, language: "en" | "zh") {
  if (language === "zh") return text.replaceAll("[redacted]", "[已隐藏]");
  let result = text.replaceAll("[已隐藏]", "[redacted]");
  for (const [original, translation] of Object.entries(messages))
    result = result.replaceAll(original, translation);
  return result
    .replace(
      /第 (\d+)\/(\d+) 次重试，等待 (\d+) 秒/g,
      "Retry $1 of $2 in $3 seconds",
    )
    .replace(/会话 (.+?) 无法打开：/g, "Could not open conversation $1: ")
    .replace(
      /上次退出时有 (\d+) 个运行未完成。已保留中断记录；工具可能产生了副作用，请核对后继续。/g,
      "$1 tasks were interrupted when the app last closed. Recovery records are saved. Check any tool changes before continuing.",
    );
}
