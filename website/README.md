# WorkLens website

WorkLens 的中文产品官网。当前实现使用 TanStack Start、TanStack Router、React、TypeScript、Tailwind CSS v4 和 Vite，在构建阶段预渲染为可独立托管的静态文件。

迁移范围与后续方向见 [TanStack 迁移方案](TANSTACK_MIGRATION_PLAN.md)，生产发布所需配置与切换步骤见 [Cloudflare 部署方案](docs/CLOUDFLARE_DEPLOYMENT_PLAN.md)。首期保留原首页的内容、图片、布局和 FAQ，不包含登录、用户系统、数据库或业务 API。

## 本地开发

使用 Node.js 24 和 npm：

```sh
npm ci --prefix website
npm run dev --prefix website
```

开发服务器默认监听 `http://localhost:3000`。

## 构建与验证

```sh
npm run typecheck --prefix website
npm run build --prefix website
npm run verify:static --prefix website
npm run test:e2e --prefix website
npm run preview:static --prefix website
```

预渲染产物位于 `website/.output/public/`。`verify:static` 会确认首页 HTML 已包含正文、图片字节未被构建过程改写、公共资源完整，并检查没有模板残留或业务 API 路径。`test:e2e` 使用本机 Chrome 检查响应式布局、导航、FAQ、API 请求和 404。`preview:static` 默认监听 `http://localhost:4173`，只提供静态产物，不启动 Start SSR 服务。

`website/wrangler.jsonc` 已改为 Cloudflare Workers Static Assets 配置；`.github/workflows/website.yml` 目前仍只运行依赖安装、类型检查、构建、静态产物验证和页面测试，不会发布网站。待 GitHub `website-production` Environment 配置 Cloudflare API Token 后，再按部署方案加入 Production Job。

旧 Worker + R2、Python/Boto3 发布脚本及其测试已经从仓库移除。Cloudflare 中仍存在的旧 R2 Bucket 和 GitHub R2 Secret 属于首次上线后的独立基础设施清理项，新站代码和构建均不引用它们。

## 内容与截图

首页文案、能力描述、下载信息和链接目前都是占位内容，首期按原内容迁移。产品状态和正式发布入口将在内容定稿后单独核验；连接器实现情况不会自动改变长期记忆或公开安装包的状态。

`public/assets/icon.png` 来自根目录的 `build/icon.png`。需要刷新桌面端真实截图时，在仓库根目录运行：

```sh
npm run build
node website/capture-app.mjs
```

截图脚本使用临时 `WORKLENS_TEST_ROOT`，不会读取真实用户会话。界面修改后至少检查 390px、1024px 和 1280px 宽度、导航锚点、键盘焦点、FAQ 展开以及未知路径 404。
