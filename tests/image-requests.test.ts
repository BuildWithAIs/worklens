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
import { pngHeader, syntheticGif, syntheticPng } from "./image-fixtures";
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

const toolImage = (
  data: Buffer,
  mimeType: string,
): Context["messages"][number] => ({
  role: "toolResult",
  toolCallId: "synthetic-image-call",
  toolName: "read",
  content: [
    { type: "text", text: "Synthetic file read result" },
    { type: "image", data: data.toString("base64"), mimeType },
  ],
  isError: false,
  timestamp: 1,
});

test.each([false, true])(
  "tool GIF survives this request and a later text turn without mutating history (animated: %s)",
  async (animated) => {
    const context: Context = {
      messages: [toolImage(syntheticGif(animated), "image/gif")],
    };
    const before = JSON.stringify(context);
    const prepared = await prepareImageContext(
      context,
      model("anthropic-messages"),
    );
    const content = prepared.messages[0].content as {
      type: string;
      mimeType?: string;
      text?: string;
    }[];
    expect(content.find((part) => part.type === "image")?.mimeType).toBe(
      "image/png",
    );
    expect(
      content.some((part) => part.text?.includes("only the first frame")),
    ).toBe(animated);
    expect(JSON.stringify(context)).toBe(before);
    context.messages.push({
      role: "user",
      content: [{ type: "text", text: "Continue the task." }],
      timestamp: 2,
    });
    await expect(
      prepareImageContext(context, model("bedrock-converse-stream")),
    ).resolves.toBeDefined();
    expect(JSON.stringify(context.messages[0])).toBe(
      JSON.stringify(JSON.parse(before).messages[0]),
    );
  },
);

test.each([
  ["image/gif", Buffer.from("GIF89a"), "unsupported or corrupt image"],
  ["image/png", pngHeader(10001, 10000), "larger than 100 megapixels"],
  ["image/bmp", Buffer.from("BM"), "unsupported or corrupt image"],
] as const)(
  "unreadable %s tool image becomes an explicit omission while other content remains usable",
  async (mimeType, bytes, reason) => {
    const context: Context = {
      messages: [
        toolImage(bytes, mimeType),
        user([picture(syntheticPng(8, 6))]),
      ],
    };
    const before = JSON.stringify(context);
    const prepared = await prepareImageContext(
      context,
      model("anthropic-messages"),
    );
    const content = prepared.messages[0].content as {
      type: string;
      text?: string;
    }[];
    expect(content[0].text).toBe("Synthetic file read result");
    expect(content.some((part) => part.type === "image")).toBe(false);
    expect(content[1].text).toContain(`[Image omitted: ${reason}.]`);
    expect(content[1].text).not.toContain("CHAT_IMAGE_");
    expect(content[1].text).toContain("Tell the user");
    expect(prepared.messages[1].content).toEqual(context.messages[1].content);
    expect(JSON.stringify(context)).toBe(before);
    context.messages.push({
      role: "user",
      content: [{ type: "text", text: "Continue." }],
      timestamp: 3,
    });
    await expect(
      prepareImageContext(context, model("anthropic-messages")),
    ).resolves.toBeDefined();
  },
);

test("tool-image recovery preserves cancellation and user-image validation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("synthetic cancellation"));
  await expect(
    prepareImageContext(
      { messages: [toolImage(syntheticGif(), "image/gif")] },
      model("anthropic-messages"),
      controller.signal,
    ),
  ).rejects.toThrow("synthetic cancellation");
  await expect(
    prepareImageContext(
      { messages: [user([picture(Buffer.from("invalid pixels"))])] },
      model("anthropic-messages"),
    ),
  ).rejects.toThrow("CHAT_IMAGE_INVALID");
  const context: Context = {
    messages: [toolImage(syntheticGif(), "image/gif")],
  };
  await expect(
    prepareImageContext(context, {
      ...model("anthropic-messages"),
      input: ["text"],
    }),
  ).resolves.toBe(context);
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

test("large tool images are resized and oversized ones are omitted instead of blocking the session", async () => {
  const context: Context = {
    messages: [
      {
        role: "toolResult",
        toolCallId: "synthetic-call",
        toolName: "read",
        content: [
          picture(syntheticPng(14786, 3390)),
          picture(pngHeader(10001, 10000)),
        ],
        isError: false,
        timestamp: 1,
      },
    ],
  };
  const prepared = await prepareImageContext(
    context,
    model("openai-responses"),
  );
  const [resized, omitted] = (
    prepared.messages[0] as (typeof context.messages)[0] & { content: any[] }
  ).content;
  expect(imageDimensions(Buffer.from(resized.data, "base64"))).toEqual({
    width: 2000,
    height: 459,
  });
  expect(omitted.type).toBe("text");
  expect(omitted.text).toContain(
    "[Image omitted: larger than 100 megapixels.]",
  );
  await expect(
    prepareImageContext(
      { messages: [user([picture(pngHeader(10001, 10000))])] },
      model("openai-responses"),
    ),
  ).rejects.toThrow("CHAT_IMAGE_DIMENSIONS");
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
  // Bedrock accepts 20 images: the four oldest tool images are left out.
  const bedrock = await prepareImageContext(
    context,
    model("bedrock-converse-stream"),
  );
  const toolContent = bedrock.messages[2].content as {
    type: string;
    text?: string;
    data?: string;
  }[];
  expect(toolContent.map((part) => part.type)).toEqual([
    ...Array(4).fill("text"),
    ...Array(4).fill("image"),
  ]);
  expect(toolContent[0].text).toContain("more images than this model accepts");
  for (const part of toolContent.slice(4))
    expect(part.data!.length).toBeLessThan((20_000_000 * 0.75) / 20);
  expect(bedrock.messages[0].content).toHaveLength(8);
  expect(bedrock.messages[1].content).toHaveLength(8);
});

test("user images over the count limit still block the request", async () => {
  const image = picture(syntheticPng(8, 6));
  await expect(
    prepareImageContext(
      {
        messages: [
          user(Array(12).fill(image)),
          user(Array(9).fill(image)),
          {
            role: "toolResult",
            toolCallId: "synthetic-call",
            toolName: "read",
            content: [image],
            isError: false,
            timestamp: 2,
          },
        ],
      },
      model("bedrock-converse-stream"),
    ),
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
