import { expect, test, vi } from "vitest";
import { ConfluenceAdapter } from "../src/main/confluence/adapter";
import { ConfluenceHttp } from "../src/main/confluence/http";
import { setup } from "./confluence-setup";

test.each(["data-center", "cloud"] as const)(
  "%s historical reads select the appropriate status and reject unexpected versions",
  async (deployment) => {
    const f = await setup();
    let returnedVersion = 6;
    const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      expect(new URL(String(url)).searchParams.get("status")).toBe(
        deployment === "cloud" ? "current" : "historical",
      );
      expect(new URL(String(url)).searchParams.get("version")).toBe("6");
      return Response.json({
        id: "1",
        version: { number: returnedVersion },
        body: { storage: { value: "<p>Old</p>" } },
      });
    });
    const adapter = new ConfluenceAdapter(
      new ConfluenceHttp(
        {
          ...f.connections.snapshot(),
          settings: { ...f.connections.info(), deployment },
        },
        undefined,
        fetcher,
      ),
    );
    expect((await adapter.page("1", "page", 6)).version).toBe(6);
    returnedVersion = 7;
    await expect(adapter.page("1", "page", 6)).rejects.toMatchObject({
      code: "invalid_response",
    });
  },
);

test("explicit current version falls back from historical 404 without accepting another version", async () => {
  const f = await setup();
  const fetcher: typeof fetch = async (url) => {
    const query = new URL(String(url)).searchParams;
    if (query.get("status") === "historical")
      return new Response(null, { status: 404 });
    return Response.json({
      id: "1",
      version: { number: 7 },
      body: { storage: { value: "current" } },
    });
  };
  const adapter = new ConfluenceAdapter(
    new ConfluenceHttp(f.connections.snapshot(), undefined, fetcher),
  );
  expect((await adapter.page("1", "page", 7)).version).toBe(7);
  await expect(adapter.page("1", "page", 6)).rejects.toMatchObject({
    status: 404,
  });
});

test.each([false, true])(
  "page edits use one GET and server-side conflict protection (raced: %s)",
  async (raced) => {
    const f = await setup();
    await f.call({ operation: "read_page", page: "1" });
    f.fixture.requests.length = 0;
    const update = ConfluenceAdapter.prototype.update;
    const spy = vi
      .spyOn(ConfluenceAdapter.prototype, "update")
      .mockImplementation(function (this: ConfluenceAdapter, ...args) {
        if (raced) f.fixture.state.version++;
        return update.apply(this, args);
      });
    try {
      const out = await f.call(
        {
          operation: "append_page",
          page: "1",
          expectedVersion: 7,
          content: "Added",
        },
        true,
      );
      expect(out.data.status).toBe(raced ? "conflict" : "success");
      expect(f.fixture.requests.filter((r) => r.method === "GET")).toHaveLength(
        1,
      );
      expect(f.fixture.requests.filter((r) => r.method === "PUT")).toHaveLength(
        1,
      );
      expect(f.fixture.state.storage.includes("Added")).toBe(!raced);
    } finally {
      spy.mockRestore();
    }
  },
);
