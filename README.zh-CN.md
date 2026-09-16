# WorkLens

[English](README.md) | 简体中文

[项目主页](https://worklens.buildwithais.com/) · [网站部署说明](website/README.md)

WorkLens 是一款本地优先的工作 Agent，面向中大型企业的员工——尤其是日常依赖 Jira、Confluence、GitHub 等企业服务的团队。随着记忆能力的加入，它会越来越“懂”你。

基于 Electron、React、TypeScript、Tailwind CSS 和 Pi 进行开发。

## Confluence

在 **设置 → 连接** 中填写站点地址和 token，即可连接一个 Confluence 服务，查找和阅读文档、按版本修改内容、发布带附件的 Markdown，并将下载和导出文件保存在当前会话中。Cloud 使用邮箱和 API token，Data Center 使用 PAT。详见[配置、操作范围与验证说明](docs/connectors/confluence.md)。

## 联网搜索（Tavily）

在 **设置 → 连接器** 中填入 Tavily API key，助手即可使用 `web_search` 和 `web_fetch`。详见 [设置、工具与错误状态](docs/connectors/tavily.md)。

## 本地运行

需要 Node.js 24 和 npm。

```sh
npm ci
node node_modules/electron/install.js
npm run dev
```

生产构建运行：

```sh
npm run build
npm start
```

首次启动进入设置：选择服务商 → 完成认证流程 → 选择并保存默认模型 → 测试连接 → 新建会话。

## 验证与打包

```sh
npm run typecheck
npm test
npm run test:e2e
npm run pack
npm run dist:win
# 在 macOS 构建
npm run dist:mac
```

`npm test` 使用真实 Pi 运行时与基础工具、进程和临时文件，模型传输由本机 HTTP 测试服务器控制，不依赖付费账户。`test:e2e` 通过 Playwright 启动真正的 Electron，覆盖认证交互、系统凭据加密、文件任务、主题与重启。

已下载 Electron 时，可避免打包器重复下载：

```sh
npm run build
npx electron-builder --win nsis --config.electronDist=node_modules/electron/dist
```

打包产物测试（PowerShell）：

```powershell
$env:WORKLENS_PACKAGED_EXE = 'release/win-unpacked/WorkLens.exe'
npx playwright test tests/e2e/packaged.spec.ts
```

安装文件输出到 `release/`。构建默认不会上传、发布或自动更新应用。正式分发前需要自己的代码签名、macOS 公证和干净环境安装验收。

## 源码结构

办公服务按服务划分在 `src/main/connectors/` 下，并配套组织设置组件和测试。详见[连接器目录与接入约定](docs/connectors/README.md)。

```text
src/main/        应用生命周期、模型与认证、会话运行、调度、存储、输入校验
src/preload/     最小类型化 Electron 桥
src/shared/      IPC 与界面展示契约
src/renderer/    React 会话与设置界面
tests/          本地 HTTP 模型测试服务、真实 Pi 集成与 Electron 验收
build/          安装包图标
reference/      本地参考克隆，不打包、不提交
```
