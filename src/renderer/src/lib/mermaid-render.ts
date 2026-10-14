import type { MermaidConfig } from "mermaid";

export type DiagramTheme = {
  dark: boolean;
  text: string;
  muted: string;
  node: string;
  nodeBorder: string;
  cluster: string;
  clusterBorder: string;
  line: string;
  label: string;
  fontFamily: string;
};

export type RenderedDiagram = { src: string; width: number; height: number };

export const maxDiagramLength = 50_000;
// SVG labels cannot apply inline formatting, so keep only the text.
const formattingTags =
  /<\/?(?:b|strong|i|em|u|s|small|big|sub|sup|mark|span|font|code)(?:\s[^<>]*)?>/gi;

/**
 * Match the existing static HTML preview: diagrams must be self-contained.
 * Returns the source Mermaid should render, or undefined when it embeds content.
 */
export function prepareDiagramSource(code: string) {
  const source = code.replace(formattingTags, "");
  const markup = source
    .replace(/&(?:lt|#0*60|#x0*3c);/gi, "<")
    .replace(/&(?:gt|#0*62|#x0*3e);/gi, ">")
    .replace(/<br\s*\/?\s*>/gi, "")
    // Mermaid annotations such as <<choice>> and <<interface>> are not markup.
    .replace(/<<[\w\s-]+>>/g, "");
  return /<\/?[a-z][^>]*>/i.test(markup) || /\b(?:img|image)\s*:/i.test(code)
    ? undefined
    : source;
}

export function isStaticDiagramSource(code: string) {
  return prepareDiagramSource(code) !== undefined;
}
let sequence = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Mermaid shares configuration and a scratch DOM; serialize and always clean up. */
export function renderMermaid(
  code: string,
  theme: DiagramTheme,
  signal: AbortSignal,
): Promise<RenderedDiagram | undefined> {
  if (code.length > maxDiagramLength)
    return Promise.reject(new Error("Diagram too large"));
  const source = prepareDiagramSource(code);
  if (source === undefined)
    return Promise.reject(new Error("Diagram contains embedded content"));
  const task = queue.then(async () => {
    if (signal.aborted) return;
    const { default: mermaid } = await import("mermaid");
    if (signal.aborted) return;
    const config: MermaidConfig = {
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      htmlLabels: false,
      maxTextSize: maxDiagramLength,
      maxEdges: 500,
      layout: "dagre",
      theme: "base",
      fontFamily: theme.fontFamily,
      secure: [
        ...Object.keys(mermaid.mermaidAPI.defaultConfig),
        "htmlLabels",
        "themeCSS",
        "themeVariables",
      ],
      themeCSS: [
        "* { animation: none !important; transition: none !important; }",
        // Some renderers attach drop-shadow filters directly to shapes.
        "[filter] { filter: none !important; }",
        ".cluster-label, .cluster-label text { font-weight: 500; }",
        ".edgeLabel, .edgeLabel p { font-size: 12px; }",
        ".node rect, rect.actor { rx: 6px; ry: 6px; } .cluster rect { rx: 8px; ry: 8px; }",
      ].join(" "),
      // Flat, low-contrast surfaces that match code blocks; Mermaid's default
      // look adds gradients and drop shadows.
      themeVariables: {
        darkMode: theme.dark,
        background: theme.node,
        primaryColor: theme.node,
        primaryTextColor: theme.text,
        primaryBorderColor: theme.nodeBorder,
        secondaryColor: theme.cluster,
        secondaryBorderColor: theme.clusterBorder,
        tertiaryColor: theme.cluster,
        tertiaryBorderColor: theme.clusterBorder,
        nodeBorder: theme.nodeBorder,
        clusterBkg: theme.cluster,
        clusterBorder: theme.clusterBorder,
        lineColor: theme.line,
        arrowheadColor: theme.line,
        edgeLabelBackground: theme.label,
        titleColor: theme.muted,
        textColor: theme.text,
        noteBkgColor: theme.cluster,
        noteBorderColor: theme.clusterBorder,
        noteTextColor: theme.text,
        signalColor: theme.muted,
        signalTextColor: theme.text,
        sequenceNumberColor: theme.node,
        actorBkg: theme.node,
        actorBorder: theme.nodeBorder,
        actorTextColor: theme.text,
        actorLineColor: theme.clusterBorder,
        activationBkgColor: theme.cluster,
        activationBorderColor: theme.nodeBorder,
        labelBoxBkgColor: theme.cluster,
        labelBoxBorderColor: theme.nodeBorder,
        labelTextColor: theme.text,
        loopTextColor: theme.text,
        useGradient: false,
        dropShadow: "none",
        radius: 6,
        strokeWidth: 1,
        fontSize: "14px",
        fontFamily: theme.fontFamily,
      },
    };
    const container = document.createElement("div");
    container.dataset.mermaidScratch = "true";
    Object.assign(container.style, {
      position: "fixed",
      visibility: "hidden",
      pointerEvents: "none",
      width: "1000px",
    });
    document.body.append(container);
    try {
      mermaid.initialize(config);
      const { svg } = await mermaid.render(
        `worklens-diagram-${++sequence}`,
        source,
        container,
      );
      if (signal.aborted) return;
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      const root = doc.documentElement;
      if (root.localName !== "svg" || doc.querySelector("parsererror"))
        throw new Error("Invalid diagram SVG");
      const [, , width, height] = (root.getAttribute("viewBox") ?? "")
        .split(/[\s,]+/)
        .map(Number);
      if (!(width > 0 && height > 0)) throw new Error("Invalid diagram size");
      root.setAttribute("width", String(width));
      root.setAttribute("height", String(height));
      // SVG images cannot run scripts or style the surrounding application.
      return {
        src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`,
        width,
        height,
      };
    } finally {
      container.remove();
    }
  });
  queue = task.catch(() => {});
  return task;
}
