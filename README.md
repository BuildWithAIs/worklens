# WorkLens

本地优先的桌面工作 Agent。直接描述任务，需要时附上文件路径；无需为会话选择工作目录。

基于 Electron、React、TypeScript、Tailwind CSS 和 Pi `createAgentSession()`。Pi 相关依赖固定为 **0.85.1**，参考代码仅用于理解接口，不参与应用构建。

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

首次启动进入设置：选择服务商 → 完成 Pi 认证流程 → 选择并保存默认模型 → 测试连接 → 新建会话。配置完成后可直接发送，不再弹出本地工具确认框。没有配置模型时，历史仍可浏览，发送按钮不可用。

Electron 下载受网络限制时，可仅在安装命令的环境中设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。不要禁用下载校验。

## 已实现

- Pi 内置文本服务商与模型目录、通用密钥/OAuth/设备码/多字段认证界面、Azure 端点与部署映射、受限连接测试。
- Pi JSONL 会话新建、列表、重命名、删除、恢复，独立模型和推理等级。
- 多会话同时运行；按会话与运行 ID 精确取消；同会话禁止重复发送；流式文本、推理摘要、工具参数与结果、重试与压缩状态。
- Pi 文件工具和平台 Shell；同一运行中的副作用工具顺序执行，同文件的跨会话写入排队且等待可取消。
- Windows DPAPI / macOS Keychain 对接的 Electron `safeStorage` 凭据存储；只暴露类型化 IPC；渲染进程没有 Node、文件或 Shell API。
- 浅色、深色、系统主题，Markdown、代码高亮与复制，键盘发送与新建会话。
- 关闭窗口取消活跃任务；意外中断提示与待发送内容恢复草稿，不自动重放工具。

## 数据位置

| 内容                               | 正式版                 | 开发版                       |
| ---------------------------------- | ---------------------- | ---------------------------- |
| 初始运行目录                       | `~/.worklens/runtime`  | `~/.worklens-dev/runtime`    |
| Pi 会话历史                        | `~/.worklens/sessions` | `~/.worklens-dev/sessions`   |
| 设置、加密凭据、模型缓存、恢复记录 | Electron `userData`    | `WorkLens-dev` 的 `userData` |

自动化测试通过 `WORKLENS_TEST_ROOT` 指向临时目录。它也可用于打包产物的隔离验收。不要让测试使用真实用户的数据目录。

运行目录不是沙箱。工具可以访问当前系统用户有权访问的其他路径、执行命令、启动进程和访问网络。重要修改的对话确认仅是提示词约定；第一版没有权限模块。模型请求可能包含任务相关文件和命令输出。

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

详见 [架构决策](docs/architecture.md)、[UI 技术方案与路线](docs/ui-architecture-and-roadmap.md)、[测试与交付状态](docs/verification.md) 和 [PRD 交付核对](docs/prd-audit.md)。

## 源码结构

```text
src/main/        应用生命周期、模型与认证、会话运行、调度、存储、输入校验
src/preload/     最小类型化 Electron 桥
src/shared/      IPC 与界面展示契约
src/renderer/    React 会话与设置界面
tests/          本地 HTTP 模型测试服务、真实 Pi 集成与 Electron 验收
build/          安装包图标
reference/      本地参考克隆，不打包、不提交
```

许可证：MIT。依赖声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
