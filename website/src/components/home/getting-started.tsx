import { siteConfig } from "@/config/site";
import { gettingStartedSteps } from "@/content/home";

export function GettingStarted() {
  return (
    <section id="start" className="content" aria-labelledby="start-title">
      <div className="start">
        <div>
          <p className="overline">02 / 开始使用</p>
          <h2 id="start-title">
            带上你的模型，
            <br />
            开始第一项工作。
          </h2>
          <p>
            当前适合愿意从源码运行的早期使用者。
            <br />
            需要 Node.js 24、npm，以及可用的模型服务账号。
          </p>
          <a href={siteConfig.gettingStarted}>
            查看完整安装说明 <span aria-hidden="true">↗</span>
          </a>
        </div>
        <ol className="steps">
          {gettingStartedSteps.map((step) => (
            <li key={step.title}>
              <div>
                <strong>{step.title}</strong>
                <span>{step.description}</span>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
