import type { SearchableMessage } from "./conversation-search";

export interface SearchIndex {
  key: string;
  source?: string;
  messages?: SearchableMessage[] | null;
  parsed: Map<string, string>;
}

/** Conservative UTF-16 byte accounting, including the retained Markdown keys. */
function sizeOf(index: SearchIndex) {
  let bytes = 256 + index.key.length * 2 + (index.source?.length ?? 0) * 2;
  for (const message of index.messages ?? [])
    bytes +=
      64 +
      (message.text.length +
        message.folded.length +
        (message.turnId?.length ?? 0)) *
        2;
  for (const [source, text] of index.parsed)
    bytes += 64 + (source.length + text.length) * 2;
  return bytes;
}

function partialIndex(index: SearchIndex, limit: number): SearchIndex {
  const partial: SearchIndex = { key: index.key, parsed: new Map() };
  let bytes = sizeOf(partial);
  if (index.source && bytes + index.source.length * 2 <= limit) {
    partial.source = index.source;
    bytes += index.source.length * 2;
  }
  // Keep recent replies individually. Never retain an incomplete message list:
  // callers rebuild it from the full conversation and reuse these parse results.
  for (const [source, text] of [...index.parsed].reverse()) {
    const messageBytes = 64 + (source.length + text.length) * 2;
    if (bytes + messageBytes > limit) continue;
    partial.parsed.set(source, text);
    bytes += messageBytes;
  }
  return partial;
}

export class SearchCache {
  private entries = new Map<string, { index: SearchIndex; bytes: number }>();
  bytes = 0;
  constructor(readonly limit = 16 * 1024 * 1024) {}

  get(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.index;
  }

  set(id: string, index: SearchIndex) {
    this.delete(id);
    // Reserve room for other conversations, including when a complete index
    // fits the global budget but would otherwise dominate the cache.
    const entryLimit = Math.floor(this.limit / 4);
    if (sizeOf(index) > entryLimit) index = partialIndex(index, entryLimit);
    const bytes = sizeOf(index);
    if (bytes > entryLimit) return;
    while (this.bytes + bytes > this.limit)
      this.delete(this.entries.keys().next().value!);
    this.entries.set(id, { index, bytes });
    this.bytes += bytes;
  }

  delete(id: string) {
    const entry = this.entries.get(id);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(id);
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}
