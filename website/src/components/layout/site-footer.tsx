import { siteConfig } from "@/config/site";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div>
        <a className="brand" href="/">
          WorkLens
        </a>
        <p>让注意力，回到工作本身。</p>
      </div>
      <div>
        <div className="footer-links">
          <a href={siteConfig.repository}>源码</a>
          <a href={siteConfig.issues}>反馈问题</a>
          <a href={siteConfig.license}>MIT License</a>
        </div>
        <p>由 BuildWithAIs 开发 · 基于 Pi 构建</p>
      </div>
    </footer>
  );
}
