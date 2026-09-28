import { afterEach, expect, test } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Context, Model, Api } from "@earendil-works/pi-ai";
import { Agent } from "@earendil-works/pi-agent-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareImageContext,
  assertImageRequestSize,
  installImageRequestGuard,
  imageRequestLimits,
} from "../src/main/image-requests";
import { imageDimensions } from "../src/shared/image-dimensions";
import { validateChatImages } from "../src/main/chat-images";
import { syntheticPng } from "./image-fixtures";
import { fixtureModel } from "./mock-server";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const model = (api: Api): Model<Api> => ({
  ...fixtureModel,
  provider: "worklens-test",
  api,
  baseUrl: "http://127.0.0.1:1",
  input: ["text", "image"],
});
const picture = (data: Buffer) => ({
  type: "image" as const,
  mimeType: "image/png",
  data: data.toString("base64"),
});
const user = (images: ReturnType<typeof picture>[]) => ({
  role: "user" as const,
  content: images,
  timestamp: 1,
});

test("provider preparation resizes encoded-size and long-edge violations without changing stored originals", async () => {
  const image = picture(syntheticPng(1280, 1280, true));
  expect(
    validateChatImages(
      [{ ...image, type: undefined, name: "synthetic.png" }].map(
        ({ type: _type, ...rest }) => rest,
      ),
    ),
  ).toHaveLength(1);
  expect(image.data.length).toBeGreaterThan(5 * 1024 * 1024);
  const context = {
    messages: [user([image, picture(syntheticPng(100, 9000))])],
  };
  const before = JSON.stringify(context);
  const prepared = await prepareImageContext(
    context,
    model("bedrock-converse-stream"),
  );
  const content = prepared.messages[0]
    .content as (typeof context.messages)[0]["content"];
  for (const item of content) {
    expect(item.data.length).toBeLessThan(4_500_000);
    const size = imageDimensions(Buffer.from(item.data, "base64"));
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2000);
  }
  expect(JSON.stringify(context)).toBe(before);
});

test("all retained turns and tool images share the request budget", async () => {
  const image = picture(syntheticPng(800, 800, true));
  const context: Context = {
    messages: [
      user(Array(8).fill(image)),
      user(Array(8).fill(image)),
      {
        role: "toolResult",
        toolCallId: "synthetic-call",
        toolName: "read",
        content: Array(8).fill(image),
        isError: false,
        timestamp: 2,
      },
    ],
  };
  const prepared = await prepareImageContext(
    context,
    model("anthropic-messages"),
  );
  expect(prepared.messages).toHaveLength(3);
  for (const message of prepared.messages)
    for (const part of message.content) {
      if (typeof part !== "string" && part.type === "image")
        expect(part.data.length).toBeLessThan((20_000_000 * 0.75) / 24);
    }
  await expect(
    prepareImageContext(context, model("bedrock-converse-stream")),
  ).rejects.toThrow("CHAT_IMAGE_REQUEST");
});

test("final payload guard includes system text and binary image encoding", () => {
  const chosen = model("bedrock-converse-stream");
  expect(() =>
    assertImageRequestSize(
      { messages: [{ image: { bytes: new Uint8Array(4_000_000) } }] },
      chosen,
    ),
  ).not.toThrow();
  expect(() =>
    assertImageRequestSize({ system: "x".repeat(20_000_001) }, chosen),
  ).toThrow("CHAT_IMAGE_REQUEST");
});

for (const api of ["anthropic-messages", "bedrock-converse-stream"] as const)
  test(`${api} actual Pi payload contains the processed image`, async () => {
    const root = await mkdtemp(join(tmpdir(), "worklens-image-request-"));
    roots.push(root);
    const runtime = await ModelRuntime.create({
      modelsPath: null,
      authPath: join(root, "auth.json"),
      allowModelNetwork: false,
    });
    runtime.registerProvider("worklens-test", {
      api,
      baseUrl: "http://127.0.0.1:1",
      apiKey: "fixture",
      models: [{ ...fixtureModel, input: ["text", "image"] }],
    });
    await runtime.refresh({ allowNetwork: false });
    const chosen = runtime.getModel("worklens-test", fixtureModel.id)!;
    let captured: any;
    const agent = new Agent({
      initialState: { model: chosen },
      streamFn: (current, context, options) =>
        runtime.streamSimple(current, context, {
          ...options,
          apiKey: "fixture",
          maxRetries: 0,
        }),
      onPayload: (payload) => {
        captured = payload;
        throw new Error("LOCAL_PAYLOAD_CAPTURE");
      },
    });
    installImageRequestGuard(agent);
    await agent.prompt(user([picture(syntheticPng(100, 9000))]));
    expect(captured).toBeDefined();
    const block = captured.messages[0].content.find(
      (item: any) => item.image || item.type === "image",
    );
    const bytes =
      api === "anthropic-messages"
        ? Buffer.from(block.source.data, "base64")
        : Buffer.from(block.image.source.bytes);
    expect(imageDimensions(bytes).height).toBeLessThanOrEqual(2000);
    expect(bytes.toString("base64").length).toBeLessThan(
      imageRequestLimits(chosen).encodedImage,
    );
  });
