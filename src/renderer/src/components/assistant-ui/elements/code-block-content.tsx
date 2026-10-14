import { memo, useMemo } from "react";
import { useAuiState } from "@assistant-ui/react";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { highlightCode } from "@/lib/syntax-highlight";
import { MermaidDiagram } from "./mermaid-diagram";

export const codeBlockClassName =
  "aui-md-pre border-border/30 bg-muted/30 my-3 overflow-x-auto rounded-md border text-xs leading-relaxed";

export const CodeBlockContent = memo(function CodeBlockContent({
  code,
  language,
  components: { Pre, Code },
}: SyntaxHighlighterProps) {
  const streaming = useAuiState((s) => s.message.status?.type === "running");
  const highlighted = useMemo(
    () => (streaming ? undefined : highlightCode(code, language)),
    [code, language, streaming],
  );
  if (language.toLowerCase() === "mermaid")
    return (
      <MermaidDiagram
        code={code}
        streaming={streaming}
        className={codeBlockClassName}
        components={{ Pre, Code }}
      />
    );
  return (
    <Pre>
      {highlighted === undefined ? (
        <Code>{code}</Code>
      ) : (
        <Code dangerouslySetInnerHTML={{ __html: highlighted }} />
      )}
    </Pre>
  );
});
