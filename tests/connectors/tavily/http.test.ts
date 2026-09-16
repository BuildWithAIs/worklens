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
