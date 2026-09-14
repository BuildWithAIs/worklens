export function ProductPreview() {
  return (
    <figure>
      <div className="product-frame">
        <a
          href="/assets/worklens.png"
          aria-label="查看完整 WorkLens 桌面界面截图"
        >
          <img
            src="/assets/worklens.png"
            width="1440"
            height="900"
            alt="WorkLens 桌面应用的新会话界面，左侧是历史会话，右侧是任务输入与模型选择区域。"
            fetchPriority="high"
          />
        </a>
      </div>
      <figcaption>
        <span>一个安静的工作界面，从一条任务开始。</span>
        <span>实际应用截图 · 隔离测试环境</span>
      </figcaption>
    </figure>
  );
}
