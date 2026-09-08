import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
export async function mockServer() {
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    requests.push(input);
    const messages = input.messages ?? [];
    const lastUserIndex = messages.findLastIndex((m: any) => m.role === "user");
    const raw = messages[lastUserIndex]?.content ?? "";
    const userText =
      typeof raw === "string"
        ? raw
        : raw.map((p: any) => p.text ?? "").join("");
    const toolResult = messages
      .slice(lastUserIndex)
      .find((m: any) => m.role === "tool");
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    const chunk = (delta: object, finish: string | null = null) => {
      if (!response.destroyed)
        response.write(
          `data: ${JSON.stringify({ id: "chat-" + randomUUID(), object: "chat.completion.chunk", created: 1, model: "worklens-test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
    };
    chunk({ role: "assistant" });
    if (userText.startsWith("TOOL ") && !toolResult) {
      const spec = JSON.parse(userText.slice(5));
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call-" + randomUUID(),
            type: "function",
            function: { name: spec.name, arguments: "" },
          },
        ],
      });
      chunk({
        tool_calls: [
          { index: 0, function: { arguments: JSON.stringify(spec.args) } },
        ],
      });
      chunk({}, "tool_calls");
    } else {
      const answer =
        userText === "Reply with OK only."
          ? "OK"
          : `已完成：${toolResult ? toolResult.content : userText}`;
      for (const part of answer.match(/.{1,8}/gs) ?? []) {
        if (response.destroyed) break;
        chunk({ content: part });
        await new Promise((resolve) =>
          setTimeout(resolve, userText.includes("SLOW") ? 120 : 8),
        );
      }
      chunk({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
export const fixtureModel = {
  id: "worklens-test",
  name: "本地测试模型",
  reasoning: false,
  input: ["text"] as ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32000,
  maxTokens: 1024,
};
