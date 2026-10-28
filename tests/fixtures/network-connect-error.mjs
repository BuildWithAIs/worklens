import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Agent, fetch } from "undici";
import { bypassLookup } from "../../src/main/network-proxy.ts";

// Replace the native TCP result only in this disposable child process. DNS,
// net, TLS, Undici and the production lookup still execute their real paths.
const tcp = process.binding("tcp_wrap").TCP.prototype;
const original = tcp.connect;
const unavailable = process.binding("uv").UV_EADDRNOTAVAIL;
const refused = process.binding("uv").UV_ECONNREFUSED;
const agent = new Agent({
  connect: { lookup: bypassLookup([{ address: "192.0.2.1", family: 4 }]) },
});
try {
  for (const [nativeCode, code] of [
    [unavailable, "EADDRNOTAVAIL"],
    [refused, "ECONNREFUSED"],
  ]) {
    tcp.connect = () => nativeCode;
    await assert.rejects(
      fetch("https://failure.example.test/", {
        dispatcher: agent,
        signal: AbortSignal.timeout(2000),
      }),
      (error) => error.cause?.code === code,
    );
  }
} finally {
  tcp.connect = original;
  await agent.destroy();
}
const server = createServer((_request, response) => response.end("recovered"));
const healthy = new Agent({
  connect: { lookup: bypassLookup([{ address: "127.0.0.1", family: 4 }]) },
});
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const response = await fetch(
    `http://recovery.example.test:${server.address().port}/`,
    { dispatcher: healthy },
  );
  assert.equal(await response.text(), "recovered");
  console.log("request failures handled; subsequent request succeeded");
} finally {
  await healthy.destroy();
  await new Promise((resolve) => server.close(resolve));
}
