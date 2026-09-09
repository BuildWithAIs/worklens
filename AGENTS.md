# 仓库贡献指南

## 项目结构与模块划分

本项目是本地优先的桌面工作助手，使用 Electron、React、TypeScript、Tailwind CSS 和 Pi。

- `src/main/`：应用生命周期、服务商、认证、会话执行、存储、工具和输入校验。
- `src/preload/`：最小化的类型化进程桥接；`src/shared/`：进程通信与界面数据契约。
- `src/renderer/src/`：界面组件与样式。
- `tests/`：集成测试及本地模型测试服务器；`tests/e2e/`：桌面端到端测试。
- `build/`：安装包图标。
- `dist/`、`release/`：构建产物。`reference/` 和 `prd.md` 属于本地忽略内容，不要提交。

## 安装、开发与构建命令

使用 Node.js 24 和 npm。

- 依次执行 `npm ci`、`node node_modules/electron/install.js`：安装锁定版本的依赖及桌面运行时。
- `npm run dev`：启动开发环境。
- `npm run typecheck`：执行严格类型检查，不生成文件。
- `npm test`：运行集成与单元测试。
- `npm run test:e2e`：构建并运行桌面验收测试。
- 依次执行 `npm run build`、`npm start`：构建并启动生产版本。
- `npm run pack`：生成未封装为安装器的应用目录。
- `npm run dist:win`、`npm run dist:mac`：分别生成对应平台的安装包；苹果系统安装包须在对应系统上构建。

## 代码风格与命名约定

沿用两空格缩进、双引号、分号和尾随逗号。组件与类型使用大驼峰命名，函数与变量使用小驼峰命名，多词服务文件名使用连字符分隔，例如 `agent-service.ts`。共享数据契约集中在 `src/shared/contracts.ts`。

已安装 Prettier，可用 `npx prettier --write <文件路径>` 格式化修改的文件；当前未配置独立的代码规范检查脚本。

## 测试要求

Vitest 测试命名为 `*.test.ts`，Playwright 测试命名为 `*.spec.ts`。行为修复应补充回归测试，重点覆盖取消、并发、持久化和凭据处理；当前没有数值化覆盖率门槛。

使用临时目录，并通过 `WORKLENS_TEST_ROOT` 隔离桌面测试数据。测试结合真实 Pi 工具和本地模型服务器，无需付费账号。打包产物测试需要设置 `WORKLENS_PACKAGED_EXE`，否则会跳过。

## 提交与合并请求

沿用历史中的 `feat:`、`docs:`、`chore:` 前缀，以简洁的动词短语描述修改，每次提交保持范围明确。合并请求应说明行为变化、关联相关问题并列出已执行的检查；界面修改附截图。明确区分本机验证、真实云端账号验证和跨平台验证。

## 架构与安全约定

以锁定版本的 Pi 公开接口为服务商与会话历史的依据。特权操作放在主进程，通过类型明确且经过校验的进程通信接口调用。禁止明文持久化凭据或在日志中暴露秘密。保留用户数据，测试不得使用真实会话目录。
