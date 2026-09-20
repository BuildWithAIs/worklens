import {
  ExportedMessageRepository,
  type ThreadMessageLike,
} from "@assistant-ui/react";

// Compare the plain presentation records, before normalization adds timestamps.
function equalPresentation(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) && equalPresentation(left[key], right[key]),
    )
  );
}

/** Reuse unchanged rendered messages without retaining removed live branches. */
export function createThreadMessageCache() {
  type Item = ExportedMessageRepository["messages"][number];
  let previous = new Map<string, { source: ThreadMessageLike; item: Item }>();
  let repository: ExportedMessageRepository = { messages: [] };
  return (sources: readonly ThreadMessageLike[]): ExportedMessageRepository => {
    const next = new Map<string, { source: ThreadMessageLike; item: Item }>();
    let parentId: string | null = null;
    const messages = sources.map((source) => {
      const cached = source.id ? previous.get(source.id) : undefined;
      const unchanged = cached && equalPresentation(cached.source, source);
      const message = unchanged
        ? cached.item.message
        : ExportedMessageRepository.fromArray([source]).messages[0].message;
      const item =
        unchanged && cached.item.parentId === parentId
          ? cached.item
          : { message, parentId };
      parentId = message.id;
      next.set(message.id, { source, item });
      return item;
    });
    previous = next;
    if (
      messages.length !== repository.messages.length ||
      messages.some((item, index) => item !== repository.messages[index])
    )
      repository = { messages };
    return repository;
  };
}
