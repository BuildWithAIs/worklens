import { expect, test, vi } from "vitest";
import { TavilyHttp } from "../../../src/main/connectors/tavily/http";

const snapshot = () => ({
  settings: { url: "https://example.test", configured: true },
  token: "synthetic-key",
  revision: "test",
  signal: new AbortController().signal,
});

test.each([undefined, "10"])(
  "stream cap stops actual bytes with content-length %s and cancels the reader",
  async (length) => {
    let reads = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel,
    });
    const fetcher = vi.fn(
      async () =>
        new Response(body, {
          headers: length ? { "content-length": length } : {},
        }),
    );
    const http = new TavilyHttp(snapshot(), fetcher as typeof fetch);
    await expect(http.request("POST", "/extract", {})).rejects.toMatchObject({
      code: "result_too_large",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(reads).toBeLessThanOrEqual(10);
    expect(fetcher).toHaveBeenCalledOnce();
  },
);

test("UTF-8 split across chunks is decoded once after the byte cap", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ content: "中文🙂" }));
  const fetcher = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
    );
  expect(
    await new TavilyHttp(snapshot(), fetcher as typeof fetch).request(
      "GET",
      "/usage",
    ),
  ).toEqual({ content: "中文🙂" });
});

test("research creation does not retry network errors or redirects", async () => {
  const failed = vi.fn(async () => {
    throw new Error("lost reply");
  });
  await expect(
    new TavilyHttp(snapshot(), failed as typeof fetch).request(
      "POST",
      "/research",
      {},
    ),
  ).rejects.toMatchObject({ code: "network" });
  expect(failed).toHaveBeenCalledOnce();
  const redirect = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://another.test" },
      }),
  );
  await expect(
    new TavilyHttp(snapshot(), redirect as typeof fetch).request(
      "POST",
      "/research",
      {},
    ),
  ).rejects.toMatchObject({ code: "redirect" });
  expect(redirect).toHaveBeenCalledOnce();
});

test("safe reads still retry transient responses", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response("", { status: 503, headers: { "retry-after": "0" } }),
    )
    .mockResolvedValueOnce(Response.json({ results: [] }));
  expect(
    await new TavilyHttp(snapshot(), fetcher).request("POST", "/search", {}),
  ).toEqual({ results: [] });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

function brokenBody() {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        controller.error(new Error("connection reset"));
      },
    }),
  );
}

test("body read failure retries safe reads and can recover", async () => {
  const fetcher = vi
    .fn()
    .mockImplementationOnce(brokenBody)
    .mockResolvedValueOnce(Response.json({ results: [] }));
  expect(
    await new TavilyHttp(snapshot(), fetcher).request("POST", "/extract", {}),
  ).toEqual({ results: [] });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("exhausted body read failures are network errors", async () => {
  const fetcher = vi.fn(brokenBody);
  await expect(
    new TavilyHttp(snapshot(), fetcher as unknown as typeof fetch).request(
      "GET",
      "/research/task-id",
    ),
  ).rejects.toMatchObject({ code: "network" });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test.each(["network", "body", "server"])(
  "usage never retries a %s failure",
  async (failure) => {
    const fetcher = vi.fn(async () => {
      if (failure === "network") throw new Error("offline");
      if (failure === "body") return brokenBody();
      return new Response(null, { status: 503 });
    });
    await expect(
      new TavilyHttp(snapshot(), fetcher).request("GET", "/usage"),
    ).rejects.toBeInstanceOf(Error);
    expect(fetcher).toHaveBeenCalledOnce();
  },
);

test.each(["120", null, "invalid", "0"])(
  "usage rate limits preserve cooldown without retries: %s",
  async (retryAfter) => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 429,
          headers: retryAfter ? { "retry-after": retryAfter } : {},
        }),
    );
    await expect(
      new TavilyHttp(snapshot(), fetcher).request("GET", "/usage"),
    ).rejects.toMatchObject({
      code: "rate_limit",
      data: {
        status: 429,
        retryAfterMs: retryAfter === "120" ? 120_000 : 600_000,
      },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  },
);

test("usage accepts an HTTP-date Retry-After", async () => {
  const now = Date.now();
  const fetcher = vi.fn(
    async () =>
      new Response(null, {
        status: 429,
        headers: { "retry-after": new Date(now + 120_000).toUTCString() },
      }),
  );
  const error = await new TavilyHttp(snapshot(), fetcher)
    .request("GET", "/usage")
    .catch((error) => error);
  expect(error.data.retryAfterMs).toBeGreaterThan(118_000);
  expect(error.data.retryAfterMs).toBeLessThanOrEqual(120_000);
  expect(fetcher).toHaveBeenCalledOnce();
});

test("research creation body failure never retries", async () => {
  const fetcher = vi.fn(brokenBody);
  await expect(
    new TavilyHttp(snapshot(), fetcher as unknown as typeof fetch).request(
      "POST",
      "/research",
      {},
    ),
  ).rejects.toMatchObject({ code: "network" });
  expect(fetcher).toHaveBeenCalledOnce();
});

test("cancellation during body failure stops retries", async () => {
  const controller = new AbortController();
  const fetcher = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          pull(stream) {
            controller.abort();
            stream.error(new Error("aborted transfer"));
          },
        }),
      ),
  );
  await expect(
    new TavilyHttp(snapshot(), fetcher, controller.signal).request(
      "POST",
      "/extract",
      {},
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).toHaveBeenCalledOnce();
});
