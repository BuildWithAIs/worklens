import { expect, test } from "vitest";
import {
  isStaticDiagramSource,
  prepareDiagramSource,
  renderMermaid,
  maxDiagramLength,
} from "../src/renderer/src/lib/mermaid-render";

test.each([
  "flowchart LR\n  A[Draft] --> B[Done]",
  'flowchart LR\n  A["First<br/>Second"] --> B[Done]',
  "sequenceDiagram\n  A->>B: Request\n  B-->>A: Reply",
  "stateDiagram-v2\n  state Gate <<choice>>\n  state Split <<fork>>",
  "classDiagram\n  class Shape {\n    <<interface>>\n  }",
  "flowchart LR\n  A[\"<b>Title</b><br/><small style='color:#0369a1'>Detail</small>\"]",
])("self-contained graph sources are accepted: %s", (source) => {
  expect(isStaticDiagramSource(source)).toBe(true);
});

test.each([
  'flowchart LR\n  A["<img src=\"https://example.invalid/pixel\">"]',
  'flowchart LR\n  A["<script>alert(1)</script>"]',
  'flowchart LR\n  A["<br onmouseover=\"alert(1)\">"]',
  'flowchart LR\n  A@{ img: "https://example.invalid/pixel" }',
  'flowchart LR\n  A["&lt;img src=\"https://example.invalid/pixel\"&gt;"]',
  'flowchart LR\n  A["<<b>img src=\"https://example.invalid/pixel\">"]',
  'stateDiagram-v2\n  state A <<img src="https://example.invalid/pixel">>',
])("embedded content is rejected before rendering: %s", (source) => {
  expect(isStaticDiagramSource(source)).toBe(false);
});

test("oversized diagrams fail before a browser or Mermaid runtime is needed", async () => {
  await expect(
    renderMermaid(
      "x".repeat(maxDiagramLength + 1),
      {} as any,
      new AbortController().signal,
    ),
  ).rejects.toThrow("Diagram too large");
});

test("inline formatting keeps its text and drops attributes", () => {
  expect(
    prepareDiagramSource(
      "flowchart LR\n  A[\"<b>Title</b><br/><small style='color:red' onclick='x()'>Detail</small>\"]",
    ),
  ).toBe('flowchart LR\n  A["Title<br/>Detail"]');
});
