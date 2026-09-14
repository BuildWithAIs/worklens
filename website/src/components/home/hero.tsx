import { siteConfig } from "@/config/site";

export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="eyebrow">本地优先的桌面工作 Agent</div>
      <h1 id="hero-title">
        让工作，
        <br />
        <span>从这里继续。</span>
      </h1>
      <p className="lead">
        把任务交给 WorkLens，在自己的电脑上推进。
        <br />
        连接你选择的模型，处理文件、执行任务，让每段工作都有迹可循。
      </p>
      <div className="actions">
        <a className="button primary" href="#start">
          从源码开始 <span aria-hidden="true">→</span>
        </a>
        <a className="button secondary" href={siteConfig.repository}>
          查看 GitHub <span aria-hidden="true">↗</span>
        </a>
      </div>
      <p className="note">早期预览 · 开源项目 · 暂未提供公开安装包</p>
    </section>
  );
}
