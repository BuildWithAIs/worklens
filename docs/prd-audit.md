# PRD 交付核对

2026-09-08。对应原始 `prd.md`，不修改其中的验收勾选。这里的“本机通过”指 Windows 开发机和可控 HTTP 模型服务，真实 Pi、文件和 PowerShell 执行；不代表商业模型账号或两个平台正式发布通过。

| 需求     | 实现位置                        | 当前证据与剩余条件                                                                  |
| -------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| 001、002 | App、providers                  | Electron 首次配置、工具说明、发送闭环通过；真实账号待测                             |
| 010、011 | providers                       | 共享 Pi 目录与通用认证，无成员白名单；所有服务保留未实测标签                        |
| 012      | storage、preload、index         | 系统加密、损坏凭据替换、IPC 不返回测试密钥已实测；macOS Keychain 待测               |
| 013      | providers、App                  | 模型能力与推理等级来自 Pi，缓存和有超时的刷新已实现；动态云目录待测                 |
| 014      | providers、App                  | Azure 环境配置与部署映射已实现；真实自定义部署待测                                  |
| 015      | providers                       | Pi 限额无工具连接请求通过本机服务；真实认证和各类云错误待测                         |
| 016      | agent-service、App              | 每会话独立模型设置、闲时切换、Pi 持久化；历史模型缺失有明确提示                     |
| 020、021 | index、agent-service、resources | 统一目录、历史 cwd 覆盖、开发测试隔离和跨目录实际工具通过                           |
| 030—034  | agent-service、App              | 草稿、新建、重命名、重启、单文件删除；30 次恢复及损坏文件隔离测试通过               |
| 035      | agent-service、App              | 20 轮双会话含实际工具并发，无事件或 JSONL 污染；延迟发送确认不切走另一会话          |
| 040、041 | agent-service、contracts、App   | 真实 Pi 流式路由、去重、独立运行状态与停止通过                                      |
| 042      | projection、App                 | 推理内容独立折叠展示；商业推理模型待测                                              |
| 043      | projection、agent-service、App  | 工具状态、路径、时间和差异展示；时间信息重启恢复通过                                |
| 044      | agent-service、tools            | 定向取消、文件等待取消、PowerShell 子进程树退出实测通过                             |
| 045      | agent-service、App              | 复用 Pi 重试并显示本会话错误；真实服务限流/认证矩阵待测                             |
| 046      | agent-service、projection       | 真实 Pi 压缩、摘要恢复及压缩前消息仍可查看通过                                      |
| 047      | App、validation、index          | Markdown、高亮、复制、受控外链及禁用渲染脚本                                        |
| 050—052  | tools、resources、projection    | 原生文件工具跨运行目录真实读写、修改、搜索通过                                      |
| 053      | tools、projection、App          | Windows PowerShell 实际目录、文件任务、退出码 0/7 和超时通过；macOS Bash 待实机验证 |
| 054、055 | tools、agent-service            | 主进程入口、Pi 副作用顺序元数据、跨会话同文件互斥与取消通过                         |
| 056      | projection、storage             | Pi 截断与有界 UI 摘要、错误/取消展示；凭据脱敏回归检查                              |
| 060      | App、storage                    | 默认模型和三种主题模式、重启恢复已通过 Electron 测试                                |
| 061、062 | resources                       | 固定职责/工具/目录说明；AGENTS 等哨兵未加载，资源自动发现关闭                       |
| 063      | index、agent-service            | 退出取消、首回复前强制崩溃后恢复草稿、不自动重放通过                                |

## 发布门尚未通过

PRD 第十七节和完成定义要求的真实 API Key 与 OAuth/设备码跨平台验证、Azure 自定义部署、macOS 安装包、两平台干净环境安装与升级验收仍未完成。当前 Windows 安装包未签名；五名试用者和二十个真实任务未执行。当前暂不配置 CI。

详见 `verification.md` 的测试范围和重跑命令。现有产物可供 Windows 本机试用，不能据此将完整 PRD 目标标为完成。
