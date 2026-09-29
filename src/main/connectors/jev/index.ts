import type { Connector } from "../types";
import type { JevService } from "./service";

export function jevConnector(service: JevService): Connector {
  return {
    id: "jev",
    instructions:
      "Jev 是可选的批量判断工具：jev_rank 对候选片段排序，jev_classify 分类，jev_check 按明确条件检查。仅在批量、重复的判断任务确有帮助时使用，简单问题由当前模型处理。先说明用途，再提交最少必需的材料及条件；应用会在发送前展示授权卡，不要另行用文字重复索要许可，也不要在参数中声称已获授权。用户拒绝后本会话继续使用现有能力，不再尝试 Jev；不得用命令或其他网络工具绕过授权。不能用 Jev 决定权限、用户授权或执行写操作。结果是带不确定性的判断，保留来源并核查重要结论。不要发送整段历史或整份文件来代替选取相关片段。",
    initialize: async () => {
      await service.consent.load();
      await service.connections.load();
    },
    configurationKey: () => service.connections.configurationKey(),
    names: () => service.names(),
    tools: (sessionId) => service.tools(sessionId),
    redact: (text) => service.connections.redact(text),
  };
}
