import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentService } from "../src/main/agent-service";
import {
  validateChatImages,
  validateImageContent,
} from "../src/main/chat-images";
import { schemas } from "../src/main/validation";
import { CHAT_IMAGE_LIMITS, type ChatImage } from "../src/shared/chat-images";
import type { ChatEvent, Selection } from "../src/shared/contracts";
import { fixtureModel, mockServer } from "./mock-server";

const image: ChatImage = {
  name: "screenshot.png",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGNoCX0HRwzEcQDdEhxxGEJJKQAAAABJRU5ErkJggg==",
};
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("main-process decoding rejects a truncated image with a valid PNG signature", async () => {
  const forged = {
    ...image,
    data: Buffer.from(image.data, "base64").subarray(0, 16).toString("base64"),
  };
  expect(validateChatImages([forged])).toHaveLength(1);
  await expect(validateImageContent([forged])).rejects.toThrow(
    "CHAT_IMAGE_INVALID",
  );
});
async function setup(vision = true) {
  const root = await mkdtemp(join(tmpdir(), "worklens-images-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = {
    runtime: join(root, "runtime"),
    sessions: join(root, "sessions"),
    userData: join(root, "app"),
  };
  const server = await mockServer();
  cleanups.push(server.close);
  const runtime = await ModelRuntime.create({ modelsPath: null });
  runtime.registerProvider("worklens-test", {
    api: "openai-completions",
    baseUrl: server.url,
    apiKey: "fixture",
    models: [{ ...fixtureModel, input: vision ? ["text", "image"] : ["text"] }],
  });
  await runtime.refresh({ allowNetwork: false });
  const events: ChatEvent[] = [];
  const service = new AgentService(
    runtime,
    paths,
    (event) => events.push(event),
    (text) => text,
  );
  await service.initialize();
  cleanups.push(() => service.shutdown());
  const selection: Selection = {
    provider: "worklens-test",
    model: fixtureModel.id,
    thinking: "off",
  };
  return { service, paths, runtime, selection, server, events };
}

test("image contract allows image-only messages and rejects forged, oversized and empty payloads", () => {
  const selection = { provider: "test", model: "test", thinking: "off" };
  expect(
    schemas.send.safeParse({
      text: "",
      images: [image],
      selection,
      requestId: "test",
    }).success,
  ).toBe(true);
  expect(
    schemas.send.safeParse({
      text: " ",
      images: [],
      selection,
      requestId: "test",
    }).success,
  ).toBe(false);
  expect(() =>
    validateChatImages([{ ...image, mimeType: "image/jpeg" }]),
  ).toThrow("CHAT_IMAGE_INVALID");
  expect(() =>
    validateChatImages([{ ...image, data: image.data + "garbage" }]),
  ).toThrow("CHAT_IMAGE_INVALID");
  expect(() => validateChatImages(Array(9).fill(image))).toThrow(
    "CHAT_IMAGE_LIMITS",
  );
  const bytes = Buffer.alloc(CHAT_IMAGE_LIMITS.perImage);
  Buffer.from(image.data, "base64").copy(bytes);
  expect(() =>
    validateChatImages(
      Array(5).fill({ ...image, data: bytes.toString("base64") }),
    ),
  ).toThrow("CHAT_IMAGE_TOTAL");
  expect(() =>
    validateChatImages([
      {
        ...image,
        data: Buffer.concat([bytes, Buffer.alloc(3)]).toString("base64"),
      },
    ]),
  ).toThrow();
  expect(
    schemas.chatImage.safeParse({
      conversationId: "../../secret",
      messageId: "x",
      index: 0,
    }).success,
  ).toBe(false);
});

test("Pi receives multiple image blocks; events stay small; images survive restart and are removed on deletion", async () => {
  const { service, selection, server, events, paths, runtime } = await setup();
  const request = {
    requestId: randomUUID(),
    text: "",
    images: [image, { ...image, name: "second.png" }],
    selection,
  };
  const view = await service.send(request);
  expect((await service.send(request)).id).toBe(view.id);
  await expect
    .poll(() => events.some((event) => event.type === "run_end"))
    .toBe(true);
  expect(server.requests).toHaveLength(1);
  const user = server.requests[0].messages.find(
    (message: any) => message.role === "user",
  );
  expect(
    user.content
      .filter((part: any) => part.type === "image_url")
      .map((part: any) => part.image_url.url),
  ).toEqual([0, 1].map(() => `data:image/png;base64,${image.data}`));
  expect(JSON.stringify(events)).not.toContain(image.data);
  const opened = await service.open(view.id);
  expect(opened.title).toBe(image.name);
  const refs = opened.messages.find(
    (message) => message.role === "user",
  )!.images!;
  expect(refs.map((ref) => ref.name)).toEqual([image.name, "second.png"]);
  expect(await service.chatImage({ conversationId: view.id, ...refs[0] })).toBe(
    `data:image/png;base64,${image.data}`,
  );
  await expect(
    service.chatImage({
      conversationId: view.id,
      messageId: refs[0].messageId,
      index: 0,
    }),
  ).rejects.toThrow("CHAT_IMAGE_MISSING");
  await service.shutdown();
  const restored = new AgentService(
    runtime,
    paths,
    () => {},
    (text) => text,
  );
  cleanups.push(() => restored.shutdown());
  await restored.initialize();
  expect(
    (await restored.open(view.id)).messages.find(
      (message) => message.role === "user",
    )!.images,
  ).toEqual(refs);
  expect(
    await restored.chatImage({ conversationId: view.id, ...refs[1] }),
  ).toContain(image.data);
  await restored.delete(view.id);
  await expect(
    restored.chatImage({ conversationId: view.id, ...refs[0] }),
  ).rejects.toThrow();
  expect(
    (await readdir(paths.sessions)).filter((file) => file.endsWith(".jsonl")),
  ).toHaveLength(0);
});

test("text-only models reject images before accepting or creating a recovery record", async () => {
  const { service, selection, server, paths } = await setup(false);
  await expect(
    service.send({
      requestId: randomUUID(),
      text: "look",
      images: [image],
      selection,
    }),
  ).rejects.toThrow("CHAT_IMAGE_MODEL");
  expect(server.requests).toHaveLength(0);
  expect(await readdir(join(paths.userData, "runs"))).toHaveLength(0);
});

test("unflushed first input journals image bytes but exposes only a count; recovery is read on demand", async () => {
  const { service, selection, server, paths, runtime } = await setup();
  const view = await service.send({
    requestId: randomUUID(),
    text: "SLOW " + "waiting ".repeat(50),
    images: [image],
    selection,
  });
  await expect.poll(() => server.requests.length).toBe(1);
  const path = join(paths.userData, "runs", `${view.runId}.pending.json`);
  const marker = JSON.parse(await readFile(path, "utf8"));
  expect(marker.images).toEqual([image]);
  // Reopen the journal while the first assistant message is still unflushed.
  const restored = new AgentService(
    runtime,
    paths,
    () => {},
    (text) => text,
  );
  cleanups.push(() => restored.shutdown());
  await restored.initialize();
  expect(restored.recoveries[0].imageCount).toBe(1);
  expect(JSON.stringify(restored.recoveries)).not.toContain(image.data);
  expect(await restored.recoveryImages(view.runId!)).toEqual([image]);
  await service.cancel(view.id, view.runId!);
  // A retained recovery marker is removed with its owning conversation.
  await writeFile(path, JSON.stringify(marker));
  await restored.delete(view.id);
  expect(restored.recoveries).toHaveLength(0);
  await expect(readFile(path)).rejects.toThrow();
});
