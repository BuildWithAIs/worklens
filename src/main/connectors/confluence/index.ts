import type { Connector } from "../types";
import type { ConfluenceService } from "./service";

export function confluenceConnector(service: ConfluenceService): Connector {
  return {
    id: "confluence",
    instructions:
      "仅在提供 confluence_read/confluence_write 时使用 Confluence；先用 capabilities 查看能力及限制。请求修改 Confluence 前先读取准确目标；局部编辑读取 storage 格式，保留其他内容，遇到版本冲突重新计算修改，unknown 写入结果先核实不重复提交。下载和导出默认保存到当前会话文件目录，用户指定路径时尊重路径；不能擅自传 overwrite=true。",
    initialize: () => service.connections.load(),
    configurationKey: () => service.connections.configurationKey(),
    names: () => service.names(),
    tools: (sessionId, runId) => service.tools(sessionId, runId),
    redact: (text) => service.connections.redact(text),
  };
}
