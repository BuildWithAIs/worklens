import type { Agent } from "@earendil-works/pi-agent-core";
import type { Context, Model, Api } from "@earendil-works/pi-ai";
import { CHAT_IMAGE_LIMITS } from "../shared/chat-images";
import { processChatImage } from "./image-processing";

const toolImageErrors = new Set([
  "CHAT_IMAGE_INVALID",
  "CHAT_IMAGE_SIZE",
  "CHAT_IMAGE_DIMENSIONS",
  "CHAT_IMAGE_REQUEST",
  "CHAT_IMAGE_PROCESSING",
  "CHAT_IMAGE_TIMEOUT",
  "CHAT_IMAGE_BUSY",
]);

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
  for (const message of context.messages)
    if (Array.isArray(message.content))
      count += message.content.filter((part) => part.type === "image").length;
  if (!count) return context;
  if (count > limits.count) throw new Error("CHAT_IMAGE_REQUEST");
  // Share the image budget across the full retained history, including tool
  // images. Leave room for text/tools; the final serialized payload is checked too.
  const maxBytes = Math.min(
    limits.encodedImage,
    Math.floor((limits.request * 0.75) / count),
  );
  const messages: Context["messages"] = [];
  for (const message of context.messages) {
    if (
      message.role === "system" ||
      message.role === "assistant" ||
      typeof message.content === "string"
    ) {
      messages.push(message);
      continue;
    }
    const content = [];
    for (const part of message.content) {
      if (part.type !== "image") {
        content.push(part);
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
            text: "WorkLens image processing: only the first frame of this animated GIF is included. The remaining frames have not been inspected. Tell the user about this limitation; do not claim to have analyzed the animation. If the task requires motion or a sequence of actions, retrieve additional frames before drawing conclusions.",
          });
      } catch (error) {
        // Cancellation must stop the request. A failed tool image, however,
        // must not poison the current request or later turns in this history.
        signal?.throwIfAborted();
        if (
          message.role !== "toolResult" ||
          !(error instanceof Error) ||
          !toolImageErrors.has(error.message)
        )
          throw error;
        content.push({
          type: "text" as const,
          text: `[Image omitted: ${error.message}.] WorkLens could not process a tool image for this model request. The original tool result is retained. Tell the user which material could not be inspected, and do not claim to have analyzed this image. Use another supported representation if the task requires it.`,
        });
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
