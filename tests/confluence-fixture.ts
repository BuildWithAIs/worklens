import { createServer } from "node:http";
export async function confluenceFixture() {
  const requests: {
    method: string;
    path: string;
    body: any;
    authorization?: string;
  }[] = [];
  const state = {
    version: 7,
    storage: '<h1>Guide</h1><p>Node 22</p><ac:structured-macro ac:name="toc"/>',
    createCount: 0,
    commentCount: 0,
    failWrite: false,
    failUpload: false,
  };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed: any;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      parsed = body;
    }
    const url = new URL(req.url!, "http://fixture");
    const path = url.pathname;
    requests.push({
      method: req.method!,
      path: req.url!,
      body: parsed,
      authorization: req.headers.authorization,
    });
    const json = (value: any, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method !== "GET" && state.failWrite) {
      state.commentCount++;
      req.socket.destroy();
      return;
    }
    if (path === "/confluence/rest/api/user/current")
      return json({ username: "fixture-user", displayName: "Fixture User" });
    if (path === "/confluence/rest/api/space/ENG")
      return json({ key: "ENG", name: "Engineering", id: "5" });
    if (path === "/confluence/rest/api/space")
      return json({ results: [{ key: "ENG", id: "5" }], _links: {} });
    if (path === "/confluence/rest/api/search")
      return json({
        results: [
          {
            content: {
              id: url.searchParams.has("start") ? "2" : "1",
              title: "Guide",
            },
          },
        ],
        _links: url.searchParams.has("start")
          ? {}
          : { next: "/confluence/rest/api/search?start=1&limit=1" },
      });
    if (path === "/confluence/rest/api/content/1") {
      if (req.method === "PUT") {
        if (parsed.version.number !== state.version + 1) return json({}, 409);
        state.version++;
        state.storage = parsed.body.storage.value;
      }
      return json({
        id: "1",
        title: "Guide",
        type: "page",
        status: "current",
        space: { key: "ENG" },
        body: { storage: { value: state.storage } },
        version: { number: state.version },
        _links: { webui: "/display/ENG/Guide" },
      });
    }
    if (path === "/confluence/rest/api/content/8")
      return json({
        id: "8",
        title: "../diagram.txt",
        version: { number: 1 },
        container: { id: "1" },
        _links: { download: "/download/attachments/1/diagram.txt" },
      });
    if (path === "/confluence/download/attachments/1/diagram.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("fixture attachment bytes");
      return;
    }
    if (path === "/confluence/rest/api/content/1/child/attachment") {
      if (req.method === "POST")
        return json(
          state.failUpload
            ? {}
            : {
                results: [
                  { id: "8", title: "diagram.txt", version: { number: 1 } },
                ],
              },
          state.failUpload ? 503 : 200,
        );
      return json({ results: [], _links: {} });
    }
    if (path === "/confluence/rest/api/content" && req.method === "POST") {
      if (parsed.type === "comment") {
        state.commentCount++;
        return json({ id: "10", version: { number: 1 } });
      }
      state.createCount++;
      return json({
        id: "1",
        title: parsed.title,
        version: { number: 1 },
        _links: { webui: "/display/ENG/Guide" },
      });
    }
    if (path.endsWith("/label")) return json({ results: [], _links: {} });
    json({ message: "Fixture route missing" }, 404);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/confluence`,
    state,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
