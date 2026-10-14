import type { Agent } from "@earendil-works/pi-agent-core";
import type { Context, Model, Api } from "@earendil-works/pi-ai";
import { CHAT_IMAGE_LIMITS } from "../shared/chat-images";
import { processChatImage } from "./image-processing";

// Reasons shown to the model when a tool image cannot be included. Keep them
// plain: the model may repeat them to the user.
const toolImageErrors = new Map([
  ["CHAT_IMAGE_INVALID", "unsupported or corrupt image"],
  [
    "CHAT_IMAGE_SIZE",
    `file larger than ${CHAT_IMAGE_LIMITS.sourceBytes / 1024 / 1024} MiB`,
  ],
  [
    "CHAT_IMAGE_DIMENSIONS",
    `larger than ${CHAT_IMAGE_LIMITS.sourcePixels / 1_000_000} megapixels`,
  ],
  [
    "CHAT_IMAGE_REQUEST",
    "could not be reduced to fit this model's request size",
  ],
  ["CHAT_IMAGE_PROCESSING", "image processing failed"],
  ["CHAT_IMAGE_TIMEOUT", "image processing timed out"],
  ["CHAT_IMAGE_BUSY", "image processing was busy"],
]);
const tooManyImages =
  "this conversation has more images than this model accepts in one request";

const omittedToolImage = (reason: string) => ({
  type: "text" as const,
  text: `[Image omitted: ${reason}.] WorkLens could not include this tool image in the model request. The original tool result is retained. Tell the user which material could not be inspected, and do not claim to have analyzed this image.`,
});

export function imageRequestLimits(
  model: Pick<Model<Api>, "api" | "provider">,
) {
  // Decimal byte budgets, with headroom for provider-specific envelopes.
  // https://platform.claude.com/docs/en/build-with-claude/vision
  // https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Message.html
  // Unknown/compatible endpoints use the conservative partner budget.
  const directClaude =
    model.api === "anthropic-messages" && model.provider === "anthropic";
  const bedrock = model.api === "bedrock-converse-stream";
  return {
    encodedImage: directClaude ? 9_500_000 : 4_500_000,
    request: directClaude ? 30_000_000 : 20_000_000,
    count: bedrock ? 20 : 100,
    edge: 2000,
  };
}

export async function prepareImageContext<T extends Context>(
  context: T,
  model: Model<Api>,
  signal?: AbortSignal,
): Promise<T> {
  if (!model.input.includes("image")) return context;
  const limits = imageRequestLimits(model);
  let count = 0;
  const toolImages: string[] = [];
  context.messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((part, partIndex) => {
      if (part.type !== "image") return;
      count++;
      if (message.role === "toolResult")
        toolImages.push(`${index}:${partIndex}`);
    });
  });
  if (!count) return context;
  // Over the count limit, leave out the oldest tool images first. Only images
  // the user attached are a hard limit, because they cannot be left out silently.
  const excess = count - limits.count;
  if (excess > toolImages.length) throw new Error("CHAT_IMAGE_REQUEST");
  const dropped = new Set(toolImages.slice(0, Math.max(0, excess)));
  // Share the image budget across the full retained history, including tool
  // images. Leave room for text/tools; the final serialized payload is checked too.
  const maxBytes = Math.min(
    limits.encodedImage,
    Math.floor((limits.request * 0.75) / (count - dropped.size)),
  );
  const messages: Context["messages"] = [];
  for (const [index, message] of context.messages.entries()) {
    if (
      message.role === "system" ||
      message.role === "assistant" ||
      typeof message.content === "string"
    ) {
      messages.push(message);
      continue;
    }
    const content = [];
    for (const [partIndex, part] of message.content.entries()) {
      if (part.type !== "image") {
        content.push(part);
        continue;
      }
      if (dropped.has(`${index}:${partIndex}`)) {
        content.push(omittedToolImage(tooManyImages));
        continue;
      }
      try {
        const resized = await processChatImage(
          part,
          {
            maxWidth: limits.edge,
            maxHeight: limits.edge,
            maxBytes,
            sourceBytes: CHAT_IMAGE_LIMITS.sourceBytes,
            sourcePixels: CHAT_IMAGE_LIMITS.sourcePixels,
            allowGif: message.role === "toolResult",
          },
          signal,
        );
        content.push({
          ...part,
          data: resized.data,
          mimeType: resized.mimeType,
        });
        if (resized.firstFrameOnly)
          content.push({
            type: "text" as const,
            text: "WorkLens image processing: only the first frame of this animated GIF is included. Later frames were not inspected. Tell the user about this limitation, and do not claim to have analyzed the animation or anything that happens after the first frame.",
          });
      } catch (error) {
        // Cancellation must stop the request. A failed tool image, however,
        // must not poison the current request or later turns in this history.
        signal?.throwIfAborted();
        const reason =
          error instanceof Error
            ? toolImageErrors.get(error.message)
            : undefined;
        if (message.role !== "toolResult" || !reason) throw error;
        content.push(omittedToolImage(reason));
      }
    }
    messages.push({ ...message, content });
  }
  return { ...context, messages };
}

export function assertImageRequestSize(payload: unknown, model: Model<Api>) {
  // Bedrock's SDK base64-encodes byte arrays during wire serialization.
  const json = JSON.stringify(payload, (_key, value) =>
    value instanceof Uint8Array
      ? Buffer.from(value).toString("base64")
      : value?.type === "Buffer" && Array.isArray(value.data)
        ? Buffer.from(value.data).toString("base64")
        : value,
  );
  if (Buffer.byteLength(json ?? "", "utf8") > imageRequestLimits(model).request)
    throw new Error("CHAT_IMAGE_REQUEST");
}

export function installImageRequestGuard(agent: Agent) {
  const stream = agent.streamFunction;
  agent.streamFunction = async (model, context, options) => {
    const prepared = await prepareImageContext(context, model, options?.signal);
    return stream(model, prepared, {
      ...options,
      onPayload: async (payload, currentModel) => {
        const finalPayload =
          (await options?.onPayload?.(payload, currentModel)) ?? payload;
        assertImageRequestSize(finalPayload, currentModel);
        return finalPayload;
      },
    });
  };
}
