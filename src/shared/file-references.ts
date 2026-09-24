import type { MessageView } from "./contracts";

/** A local filename/path candidate, not evidence that a file exists or is output. */
export function isLocalReference(value: string) {
  return (
    value.length > 0 &&
    value.length <= 4096 &&
    value === value.trim() &&
    !/[\0\r\n<>"|?*]/.test(value) &&
    !value.startsWith("#") &&
    !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value.replace(/^[A-Za-z]:[\\/]/, "/"))
  );
}

/** Successful output evidence; extensions do not participate in classification. */
export function messageOutputPaths(messages: readonly MessageView[]) {
  return [
    ...new Set(
      messages.flatMap((message) => {
        if (message.role !== "tool" || message.status !== "success") return [];
        const paths = [
          ...(message.outputPaths ?? []),
          ...(message.artifacts?.map((file) => file.path) ?? []),
        ];
        if (["write", "edit"].includes(message.toolName ?? "")) {
          if (message.targetPath) paths.push(message.targetPath);
          else {
            try {
              const path = JSON.parse(message.args ?? "{}").path;
              if (typeof path === "string") paths.push(path);
            } catch {
              /* Incomplete tool arguments are not evidence. */
            }
          }
        }
        return paths.filter(isLocalReference);
      }),
    ),
  ];
}

/** Model replies often use a basename or a shorter relative path. */
export function fileReferenceAliases(paths: readonly string[]) {
  const aliases = new Set<string>();
  for (const path of paths) {
    if (!isLocalReference(path)) continue;
    aliases.add(path);
    const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
    for (let index = 0; index < parts.length; index++)
      aliases.add(parts.slice(index).join("/"));
  }
  return [...aliases];
}

type Span = { start: number; value: string };
const boundary = /[\s`"'<>，。！？；、（）()【】\[\]{}:：;!,]/u;
/** Match known filenames exactly, including extensionless names and names with spaces. */
export function knownFileSpans(
  text: string,
  references: readonly string[],
): Span[] {
  const spans: Span[] = [];
  for (const value of new Set(references)) {
    if (!value) continue;
    let offset = 0;
    for (;;) {
      const start = text.indexOf(value, offset);
      if (start < 0) break;
      const end = start + value.length;
      offset = end;
      if (
        (start === 0 || boundary.test(text[start - 1])) &&
        (end === text.length ||
          boundary.test(text[end]) ||
          (text[end] === "." &&
            (end + 1 === text.length || boundary.test(text[end + 1]))))
      )
        spans.push({ start, value });
    }
  }
  return spans
    .sort((a, b) => a.start - b.start || b.value.length - a.value.length)
    .filter(
      (span, index, sorted) =>
        !sorted
          .slice(0, index)
          .some(
            (previous) =>
              previous.start <= span.start &&
              previous.start + previous.value.length > span.start,
          ),
    );
}

/** Detect explicit paths and generic dotted filenames, never by an extension list. */
export function localPathSpans(
  text: string,
  references: readonly string[] = [],
) {
  const pattern =
    /(?:^|[\s（(【\[、，])((?:\/(?!\/)|[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|workspace\/|artifacts\/)[^\s`<>"'，。！？；、）)】\]]+|[^\s`<>"'，。！？；、（）()【】\[\]:/\\]+\.[^\s`<>"'，。！？；、（）()【】\[\]:/\\]+)/g;
  const spans = [...text.matchAll(pattern)].flatMap((match) => {
    const value = match[1].replace(/[.,;:!?]+$/, "");
    return isLocalReference(value)
      ? [{ start: match.index! + match[0].indexOf(match[1]), value }]
      : [];
  });
  return [...knownFileSpans(text, references), ...spans]
    .sort((a, b) => a.start - b.start || b.value.length - a.value.length)
    .filter(
      (span, index, sorted) =>
        !sorted
          .slice(0, index)
          .some(
            (previous) =>
              previous.start <= span.start &&
              previous.start + previous.value.length > span.start,
          ),
    );
}

export function localReferences(
  text: string,
  references: readonly string[] = [],
) {
  const values = localPathSpans(text, references).map((item) => item.value);
  for (const match of text.matchAll(
    /`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|\]\(<([^>\n]+)>\)|\]\(([^\n]+?)\)/g,
  )) {
    let value = match.slice(1).find((part) => part !== undefined)!;
    if (match[4] !== undefined || match[5] !== undefined) {
      try {
        value = decodeURIComponent(value);
      } catch {
        /* Literal path. */
      }
    }
    if (isLocalReference(value)) values.push(value);
  }
  return [...new Set(values)];
}
