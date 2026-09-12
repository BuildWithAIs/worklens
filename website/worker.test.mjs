import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.mjs";

const revision = "a".repeat(40);
function bucket() {
  const calls = [];
  return {
    calls,
    async get(key) {
      calls.push(key);
      if (key === "current.json")
        return {
          json: async () => ({
            revision,
            files: ["index.html", "404.html", "assets/icon.png"],
          }),
        };
      return {
        body: key.endsWith("404.html") ? "Not found" : "Website",
        httpEtag: '"etag"',
        writeHttpMetadata: (headers) =>
          headers.set("Content-Type", "text/html"),
      };
    },
  };
}
test("serves release index with fixed security headers", async () => {
  const SITE = bucket();
  const response = await worker.fetch(new Request("https://example.com/"), {
    SITE,
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Website");
  assert.equal(response.headers.get("X-WorkLens-Release"), revision);
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.deepEqual(SITE.calls, [
    "current.json",
    `releases/${revision}/index.html`,
  ]);
});
test("unknown and internal paths use the release's 404", async () => {
  for (const path of [
    "missing",
    "current.json",
    "releases/old/index.html",
    "_headers",
  ]) {
    const response = await worker.fetch(
      new Request(`https://example.com/${path}`),
      { SITE: bucket() },
    );
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Not found");
  }
});
test("HEAD and conditional GET have no body", async () => {
  const head = await worker.fetch(
    new Request("https://example.com/", { method: "HEAD" }),
    { SITE: bucket() },
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const cached = await worker.fetch(
    new Request("https://example.com/", {
      headers: { "If-None-Match": 'W/"etag"' },
    }),
    { SITE: bucket() },
  );
  assert.equal(cached.status, 304);
});
test("rejects writes without touching R2", async () => {
  const SITE = bucket();
  const response = await worker.fetch(
    new Request("https://example.com/", { method: "PUT" }),
    { SITE },
  );
  assert.equal(response.status, 405);
  assert.deepEqual(SITE.calls, []);
});
test("missing deployment fails closed without leaking bucket diagnostics", async () => {
  const response = await worker.fetch(new Request("https://example.com/"), {
    SITE: {
      get: async () => {
        throw new Error("private details");
      },
    },
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.doesNotMatch(await response.text(), /private details/);
});
