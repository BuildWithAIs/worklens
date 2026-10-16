import { parentPort } from "node:worker_threads";
import { parseSearchMarkdown, searchSourceCharacters } from "./search-markdown";
import { foldSearchText } from "../shared/search-text";
import type { SearchTextKind } from "./search-parser";

parentPort!.on(
  "message",
  ({ text, kind }: { text: string; kind: SearchTextKind }) => {
    try {
      if (kind === "source") {
        parentPort!.postMessage({
          text: "",
          folded: searchSourceCharacters(text),
        });
        return;
      }
      const value = kind === "markdown" ? parseSearchMarkdown(text) : text;
      parentPort!.postMessage({ text: value, folded: foldSearchText(value) });
    } catch (error) {
      // No source content is included in errors sent back to the main process.
      parentPort!.postMessage({
        error:
          error instanceof Error ? error.message : "Couldn’t parse search text",
      });
    }
  },
);
