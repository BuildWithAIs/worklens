import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { JevConnections } from "../../../src/main/connectors/jev/connection";
import { JevConsent } from "../../../src/main/connectors/jev/consent";
import { JevService } from "../../../src/main/connectors/jev/service";
import { schemas } from "../../../src/main/validation";
import { setup, sample, secret, crypto } from "./setup";

async function pending(
  f: Awaited<ReturnType<typeof setup>>,
  session = "session-one",
) {
  await expect.poll(() => f.consent.view(session).pending.length).toBe(1);
  return f.consent.view(session).pending[0];
}
const evaluations = (f: Awaited<ReturnType<typeof setup>>) =>
  f.state.requests.filter((request) => request.path === "/v1/systemone");

test("credentials validate without evaluation and the exact preview is the only body sent after approval", async () => {
  const f = await setup();
  expect(f.state.requests.map((request) => request.path)).toEqual([
    "/v1/models",
  ]);
  expect(await readFile(join(f.root, "jev.json"), "utf8")).not.toContain(
    secret,
  );
  const result = f.call();
  const request = await pending(f);
  expect(evaluations(f)).toHaveLength(0);
  expect(request).toMatchObject({
    purpose: "classify",
    itemCount: 1,
    endpoint: `${f.url}/v1/systemone`,
  });
  expect(request.payload).toContain(sample.items[0].text);
  expect(request.payload).toContain("Product feedback");
  expect(request.payload).not.toContain(secret);
  await f.consent.reply("session-one", request.id, true);
  expect((await result).details).toMatchObject({ status: "success" });
  expect(evaluations(f)).toHaveLength(1);
  expect(evaluations(f)[0].raw).toBe(request.payload);
  expect(f.consent.view("session-one")).toEqual({
    blocked: false,
    autoAllowed: false,
    approvedBatches: 1,
    pending: [],
  });
  const saved = await readFile(join(f.root, "consent.json"), "utf8");
  expect(saved).not.toContain(sample.items[0].text);
  expect(saved).not.toContain("Product feedback");
  // An identical batch reuses consent; arbitrary changed questions cannot reuse it.
  expect((await f.call()).details).toMatchObject({ status: "success" });
  const next = f.call({
    ...sample,
    categories: [
      { id: "product", description: "Different standard" },
      sample.categories[1],
    ],
  });
  const nextRequest = await pending(f);
  expect(evaluations(f)).toHaveLength(2);
  await f.consent.reply("session-one", nextRequest.id, false);
  expect((await next).details).toMatchObject({ status: "not_sent" });
});

test("denial persists for the conversation, prevents repeat prompts, and leaves other conversations independent", async () => {
  const f = await setup();
  const result = f.call();
  await f.consent.reply("session-one", (await pending(f)).id, false);
  expect((await result).details).toMatchObject({ status: "not_sent" });
  expect((await f.call()).details).toMatchObject({ status: "not_sent" });
  expect(f.consent.view("session-one").pending).toEqual([]);
  expect(evaluations(f)).toHaveLength(0);
  const reloaded = new JevConsent(join(f.root, "consent.json"));
  await reloaded.load();
  expect(reloaded.view("session-one").blocked).toBe(true);
  const independent = f.call(sample, "session-two");
  await f.consent.reply(
    "session-two",
    (await pending(f, "session-two")).id,
    true,
  );
  expect((await independent).details).toMatchObject({ status: "success" });
  expect(f.consent.view("session-one").blocked).toBe(true);
});

test("stale, cross-conversation and forged replies cannot authorize a request", async () => {
  const f = await setup();
  const abort = new AbortController();
  const result = f.call(sample, "session-one", "jev_classify", abort.signal);
  const request = await pending(f);
  await expect(
    f.consent.reply("session-two", request.id, true),
  ).rejects.toThrow("no longer pending");
  expect(
    schemas.jevConsentReply.safeParse({
      conversationId: "session-one",
      requestId: request.id,
      allow: true,
      payload: "replacement",
    }).success,
  ).toBe(false);
  abort.abort();
  expect((await result).details).toMatchObject({ status: "cancelled" });
  await expect(
    f.consent.reply("session-one", request.id, true),
  ).rejects.toThrow("no longer pending");
  expect(evaluations(f)).toHaveLength(0);
  expect(f.consent.view("session-one").approvedBatches).toBe(0);
});

test("revoking a grant stops in-flight transport and resetting to ask does not restore old grants", async () => {
  const f = await setup();
  f.state.stall = true;
  const first = f.call();
  await f.consent.reply("session-one", (await pending(f)).id, true);
  await expect.poll(() => evaluations(f).length).toBe(1);
  await f.consent.reset("session-one", true);
  expect((await first).details).not.toMatchObject({ status: "success" });
  expect((await f.call()).details).toMatchObject({ status: "not_sent" });
  await f.consent.reset("session-one", false);
  f.state.stall = false;
  const again = f.call();
  const request = await pending(f);
  expect(f.consent.view("session-one").approvedBatches).toBe(0);
  await f.consent.reply("session-one", request.id, true);
  expect((await again).details).toMatchObject({ status: "success" });
});

test("reopening retains exact grants but an endpoint or account revision change requires approval again", async () => {
  const f = await setup();
  const first = f.call();
  await f.consent.reply("session-one", (await pending(f)).id, true);
  await first;
  const connections = new JevConnections(join(f.root, "jev.json"), crypto);
  await connections.load();
  const consent = new JevConsent(join(f.root, "consent.json"));
  await consent.load();
  const service = new JevService(connections, consent);
  const tool = service
    .tools("session-one")
    .find(({ name }) => name === "jev_classify")!;
  expect(
    (await tool.execute("reopened", sample, undefined, undefined, {} as any))
      .details,
  ).toMatchObject({ status: "success" });
  expect(consent.view("session-one").pending).toHaveLength(0);
  await f.connections.remove();
  await f.connections.save({ url: f.url, token: secret });
  const next = f.call();
  await f.consent.reply("session-one", (await pending(f)).id, false);
  await next;
});

test("disconnect while waiting prevents sending and requires a fresh request", async () => {
  const f = await setup();
  const first = f.call();
  const request = await pending(f);
  await f.connections.remove();
  await first;
  expect(f.registry.names()).toEqual([]);
  await expect(
    f.consent.reply("session-one", request.id, true),
  ).rejects.toThrow();
  expect(evaluations(f)).toHaveLength(0);
});

test("tool schemas reject unbounded, duplicate or extra arguments before any consent or network call", async () => {
  const f = await setup();
  const tool = f.service
    .tools("session-one")
    .find(({ name }) => name === "jev_classify")!;
  expect(() =>
    validateToolArguments(tool, {
      type: "toolCall",
      id: "invalid",
      name: tool.name,
      arguments: { ...sample, approved: true },
    }),
  ).toThrow();
  expect(
    (await f.call({ ...sample, items: [sample.items[0], sample.items[0]] }))
      .details,
  ).toMatchObject({ status: "error" });
  expect(
    (
      await f.call({
        ...sample,
        items: Array.from({ length: 8 }, (_, i) => ({
          id: `note${i}`,
          text: "中".repeat(10000),
        })),
      })
    ).details,
  ).toMatchObject({ status: "error" });
  expect(f.consent.view("session-one").pending).toEqual([]);
  expect(evaluations(f)).toHaveLength(0);
});

test.each(["jev_rank", "jev_check"])(
  "%s batches all item questions in a single approved request",
  async (name) => {
    const f = await setup();
    const input = {
      items: [
        ...sample.items,
        { id: "note2", text: "A sample parcel arrived early." },
      ],
      ...(name === "jev_rank"
        ? { query: "Which feedback describes a defect?" }
        : { condition: "Reports a defect" }),
    };
    const first = f.call(input, "session-one", name);
    const request = await pending(f);
    expect(Object.keys(JSON.parse(request.payload).questions)).toHaveLength(2);
    await f.consent.reply("session-one", request.id, true);
    expect((await first).details).toMatchObject({ status: "success" });
    expect(evaluations(f)).toHaveLength(1);
  },
);

test.each([302, 401, 429, 529])(
  "HTTP %i is bounded and never forwards credentials through redirects",
  async (status) => {
    const f = await setup();
    f.state.status = status;
    const first = f.call();
    await f.consent.reply("session-one", (await pending(f)).id, true);
    const result = await first;
    expect(result.details).toMatchObject({ status: "error" });
    expect(JSON.stringify(result.content)).not.toContain(secret);
    expect(evaluations(f)).toHaveLength([429, 529].includes(status) ? 3 : 1);
    expect(f.state.requests.some(({ path }) => path === "/elsewhere")).toBe(
      false,
    );
  },
);

test("malformed answers and oversized responses are rejected; corrupted consent fails closed", async () => {
  const f = await setup();
  f.state.invalidAnswer = true;
  const first = f.call();
  await f.consent.reply("session-one", (await pending(f)).id, true);
  expect((await first).details).toMatchObject({ status: "error" });
  f.state.oversize = true;
  expect((await f.call()).details).toMatchObject({ status: "error" });
  await writeFile(join(f.root, "consent.json"), "invalid");
  await expect(
    new JevConsent(join(f.root, "consent.json")).load(),
  ).rejects.toThrow("could not be read");
});

test("chat auto-allow accepts changed content only for the approved connection and can be revoked", async () => {
  const f = await setup();
  const first = f.call();
  await f.consent.reply("session-one", (await pending(f)).id, true, true);
  await first;
  expect(f.consent.view("session-one").autoAllowed).toBe(true);
  const changed = {
    ...sample,
    categories: [
      { id: "product", description: "Another criterion" },
      sample.categories[1],
    ],
  };
  expect((await f.call(changed)).details).toMatchObject({ status: "success" });
  expect(f.consent.view("session-one").pending).toHaveLength(0);
  const independent = f.call(changed, "session-two");
  await f.consent.reply(
    "session-two",
    (await pending(f, "session-two")).id,
    false,
  );
  await independent;
  const reloaded = new JevConsent(join(f.root, "consent.json"), undefined, () =>
    f.connections.consentRevision(),
  );
  await reloaded.load();
  expect(reloaded.view("session-one").autoAllowed).toBe(true);
  expect(reloaded.view("session-two").autoAllowed).toBe(false);
  await f.consent.reset("session-one", false);
  expect(f.consent.view("session-one").autoAllowed).toBe(false);
  const afterReset = f.call(changed);
  await f.consent.reply("session-one", (await pending(f)).id, true, true);
  await afterReset;
  await f.connections.remove();
  await f.connections.save({ url: f.url, token: secret });
  expect(f.consent.view("session-one").autoAllowed).toBe(false);
  const newConnection = f.call(changed);
  await f.consent.reply("session-one", (await pending(f)).id, false);
  await newConnection;
  expect(evaluations(f)).toHaveLength(3);
});

test("auto-allow requires an explicit allow on a live request", async () => {
  const f = await setup();
  const controller = new AbortController();
  const first = f.call(
    sample,
    "session-one",
    "jev_classify",
    controller.signal,
  );
  const request = await pending(f);
  expect(
    schemas.jevConsentReply.safeParse({
      conversationId: "session-one",
      requestId: request.id,
      allow: false,
      autoAllow: true,
    }).success,
  ).toBe(false);
  await expect(
    f.consent.reply("session-one", request.id, false, true),
  ).rejects.toThrow();
  controller.abort();
  await first;
  await expect(
    f.consent.reply("session-one", request.id, true, true),
  ).rejects.toThrow();
  expect(f.consent.view("session-one").autoAllowed).toBe(false);
  expect(evaluations(f)).toHaveLength(0);
});
