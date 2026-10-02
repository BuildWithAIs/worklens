import type { Agent } from "@earendil-works/pi-agent-core";
import type { Context, Model, Api } from "@earendil-works/pi-ai";
import { processChatImage } from "./image-processing";

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
      const resized = await processChatImage(
        part,
        { maxWidth: limits.edge, maxHeight: limits.edge, maxBytes },
        signal,
      );
      content.push({ ...part, data: resized.data, mimeType: resized.mimeType });
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
