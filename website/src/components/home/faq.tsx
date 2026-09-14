import { faqs } from "@/content/home";

export function FAQ() {
  return (
    <section className="content faq" aria-labelledby="faq-title">
      <div>
        <p className="overline">03 / 你可能想知道</p>
        <h2 id="faq-title">
          开始前，
          <br />
          了解这几件事。
        </h2>
      </div>
      <div>
        {faqs.map((faq, index) => (
          <details key={faq.question} open={index === 0}>
            <summary>{faq.question}</summary>
            <p>{faq.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
