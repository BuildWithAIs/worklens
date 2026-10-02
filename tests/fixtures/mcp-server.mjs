import { createInterface } from "node:readline";

const tools = [
  {
    name: "echo",
    description: "Echo fixture text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "fail",
    description: "Return a fixture error",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "slow",
    description: "Wait until cancelled",
    inputSchema: { type: "object", properties: {} },
  },
];
const pending = new Map();
const resourcesOnly = process.argv.includes("--resources-only");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const request = JSON.parse(line);
    if (request.method === "notifications/cancelled") {
      const timer = pending.get(request.params.requestId);
      if (timer) clearTimeout(timer);
      pending.delete(request.params.requestId);
      return;
    }
    if (request.id === undefined) return;
    let result;
    if (request.method === "initialize")
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: resourcesOnly
          ? { resources: {} }
          : { tools: {}, resources: {} },
        serverInfo: { name: "fixture", version: "1" },
        instructions: resourcesOnly
          ? "Read the fixture resource."
          : "Use echo to return fixture text.",
      };
    else if (request.method === "tools/list" && !resourcesOnly)
      result = { tools };
    else if (request.method === "resources/list")
      result = {
        resources: [
          { uri: "fixture://hello", name: "Hello", mimeType: "text/plain" },
        ],
      };
    else if (request.method === "resources/templates/list")
      result = { resourceTemplates: [] };
    else if (request.method === "resources/read")
      result = {
        contents: [
          {
            uri: "fixture://hello",
            text: "MCP_RESOURCE_OK",
            mimeType: "text/plain",
          },
        ],
      };
    else if (request.method === "tools/call" && !resourcesOnly) {
      if (request.params.name === "slow") {
        pending.set(
          request.id,
          setTimeout(
            () =>
              send({
                jsonrpc: "2.0",
                id: request.id,
                result: { content: [{ type: "text", text: "LATE" }] },
              }),
            60000,
          ),
        );
        return;
      }
      result = {
        content: [
          {
            type: "text",
            text:
              request.params.name === "fail"
                ? "MCP_FIXTURE_ERROR"
                : request.params.arguments.text === "RETURN_SECRET"
                  ? process.env.TOKEN
                  : request.params.arguments.text,
          },
        ],
        ...(request.params.name === "fail" ? { isError: true } : {}),
      };
    } else {
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Unknown method" },
      });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result });
  })
  .on("close", () => {
    for (const timer of pending.values()) clearTimeout(timer);
  });
