import { features } from "@/content/home";

export function Features() {
  return (
    <section id="features" className="content" aria-labelledby="features-title">
      <div className="section-top">
        <div>
          <p className="overline">01 / 为日常工作而做</p>
          <h2 id="features-title">从对话到行动。</h2>
        </div>
        <p className="section-aside">面向需要处理文件、资料与日常任务的你。</p>
      </div>
      <div className="features">
        {features.map((feature, index) => (
          <article className="feature" key={feature.title}>
            <span className="number">{String(index + 1).padStart(2, "0")}</span>
            <h3>{feature.title}</h3>
            <p>{feature.description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
