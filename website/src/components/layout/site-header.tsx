import { siteConfig } from "@/config/site";

export function SiteHeader() {
  return (
    <header className="site-header">
      <a className="brand" href="/" aria-label="WorkLens 首页">
        <img src="/assets/icon.png" width="34" height="34" alt="" />
        WorkLens
      </a>
      <nav aria-label="主导航">
        <a className="desktop-link" href="#features">
          产品能力
        </a>
        <a href="#start">开始使用</a>
        <a className="nav-source" href={siteConfig.repository}>
          GitHub <span aria-hidden="true">↗</span>
        </a>
      </nav>
    </header>
  );
}
