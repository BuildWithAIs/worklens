import { createServer } from "node:http";
export const secret = "jev-independent-fixture-key";
export const sample = {
  items: [
    { id: "note1", text: "The sample lamp arrived with a loose switch." },
  ],
  categories: [
    { id: "product", description: "Product feedback" },
    { id: "other", description: "Other topics" },
  ],
};
export async function jevFixture() {
  const state = {
    status: 200,
    invalidAnswer: false,
    stall: false,
    oversize: false,
    requests: [] as { path: string; raw: string; auth?: string }[],
  };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    state.requests.push({
      path: req.url!,
      raw,
      auth: req.headers.authorization,
    });
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${secret}`) return send(401, {});
    if (req.url === "/v1/models")
      return send(200, { models: [{ name: "jev-latest" }] });
    if (req.url !== "/v1/systemone") return send(404, {});
    if (state.stall) return;
    if (state.status !== 200) {
      res.setHeader("retry-after", "0");
      if (state.status === 302) res.setHeader("location", "/elsewhere");
      return send(state.status, { message: secret });
    }
    if (state.oversize) return send(200, { text: "x".repeat(1024 * 1024 + 1) });
    const input = JSON.parse(raw);
    const answers = Object.fromEntries(
      Object.entries(input.questions).map(([id, raw]) => {
        const question = raw as any;
        if (question.type === "noul")
          return [id, { type: "noul", noul: state.invalidAnswer ? 9 : 0.8 }];
        const keys = Object.keys(question.criteria);
        const probabilities = Object.fromEntries(
          keys.map((key, i) => [key, i === 0 ? 1 : 0]),
        );
        return [
          id,
          {
            type: question.type,
            probabilities,
            confidence: 0.9,
            ...(question.type === "choice"
              ? { choice: state.invalidAnswer ? "unknown" : keys[0] }
              : { score: 0 }),
          },
        ];
      }),
    );
    send(200, {
      model: input.model,
      answers,
      usage: { input_tokens: 100, output_tokens: 10 },
    });
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });

  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    state,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
