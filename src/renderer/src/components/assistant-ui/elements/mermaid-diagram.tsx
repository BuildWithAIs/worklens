import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import {
  CodeIcon,
  EyeIcon,
  Maximize2Icon,
  ScanIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useAppTranslation } from "@/i18n";
import {
  renderMermaid,
  type DiagramTheme,
  type RenderedDiagram,
} from "@/lib/mermaid-render";
import { TooltipIconButton } from "./tooltip-icon-button";

function readTheme(): DiagramTheme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const value = (name: string) => style.getPropertyValue(name).trim();
  return {
    dark: root.dataset.theme === "dark",
    text: value("--text"),
    muted: value("--muted"),
    node: value("--diagram-node"),
    nodeBorder: value("--diagram-node-border"),
    cluster: value("--diagram-cluster"),
    clusterBorder: value("--diagram-cluster-border"),
    line: value("--diagram-line"),
    label: value("--diagram-label"),
    fontFamily: getComputedStyle(document.body).fontFamily,
  };
}

const minZoom = 0.1;
const maxZoom = 4;
const zoomStep = 1.25;
const viewportPadding = 48;
const clampZoom = (value: number) =>
  Math.min(maxZoom, Math.max(minZoom, value));

/**
 * Shrinks large diagrams to fit but never enlarges small ones.
 * Zoom with the buttons or Ctrl/⌘ + wheel; drag to pan.
 */
function DiagramViewer({
  diagram,
  label,
  viewport,
}: {
  diagram: RenderedDiagram;
  label: string;
  viewport: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useAppTranslation();
  const [fitZoom, setFitZoom] = useState(1);
  const [zoom, setZoom] = useState<number>();
  const [panning, setPanning] = useState(false);
  const anchor = useRef<{ x: number; y: number; ratio: number }>(undefined);
  const scale = zoom ?? fitZoom;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () =>
      setFitZoom(
        clampZoom(
          Math.min(
            (element.clientWidth - viewportPadding) / diagram.width,
            (element.clientHeight - viewportPadding) / diagram.height,
            1,
          ),
        ),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [diagram.width, diagram.height]);

  // Keep the point under the cursor fixed while zooming.
  useLayoutEffect(() => {
    const element = viewport.current;
    const point = anchor.current;
    if (!element || !point) return;
    anchor.current = undefined;
    element.scrollLeft = (element.scrollLeft + point.x) * point.ratio - point.x;
    element.scrollTop = (element.scrollTop + point.y) * point.ratio - point.y;
  }, [scale]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    // React registers wheel listeners as passive, which cannot prevent page zoom.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const current = scaleRef.current;
      const next = clampZoom(current * Math.exp(-event.deltaY * 0.01));
      if (next === current) return;
      const rect = element.getBoundingClientRect();
      anchor.current = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        ratio: next / current,
      };
      setZoom(next);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (factor: number) => {
    const element = viewport.current;
    const next = clampZoom(scale * factor);
    if (element)
      anchor.current = {
        x: element.clientWidth / 2,
        y: element.clientHeight / 2,
        ratio: next / scale,
      };
    setZoom(next);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (
      event.button !== 0 ||
      (element.scrollWidth <= element.clientWidth &&
        element.scrollHeight <= element.clientHeight)
    )
      return;
    const start = {
      x: event.clientX,
      y: event.clientY,
      left: element.scrollLeft,
      top: element.scrollTop,
    };
    element.setPointerCapture(event.pointerId);
    setPanning(true);
    const onMove = (move: PointerEvent) => {
      element.scrollLeft = start.left - (move.clientX - start.x);
      element.scrollTop = start.top - (move.clientY - start.y);
    };
    const onEnd = () => {
      setPanning(false);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onEnd);
      element.removeEventListener("pointercancel", onEnd);
    };
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onEnd);
    element.addEventListener("pointercancel", onEnd);
  };

  return (
    <>
      <div className="aui-mermaid-dialog-header">
        <DialogTitle>{label}</DialogTitle>
        <div
          className="aui-mermaid-zoom"
          role="group"
          aria-label={t("diagram.zoom")}
        >
          <TooltipIconButton
            tooltip={t("diagram.zoomOut")}
            side="bottom"
            onClick={() => zoomBy(1 / zoomStep)}
            disabled={scale <= minZoom}
          >
            <ZoomOutIcon />
          </TooltipIconButton>
          <button
            type="button"
            className="aui-mermaid-zoom-value"
            onClick={() => setZoom(1)}
            aria-label={t("diagram.actualSize")}
            title={t("diagram.actualSize")}
          >
            {Math.round(scale * 100)}%
          </button>
          <TooltipIconButton
            tooltip={t("diagram.zoomIn")}
            side="bottom"
            onClick={() => zoomBy(zoomStep)}
            disabled={scale >= maxZoom}
          >
            <ZoomInIcon />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip={t("diagram.fit")}
            side="bottom"
            onClick={() => setZoom(undefined)}
            aria-pressed={zoom === undefined}
          >
            <ScanIcon />
          </TooltipIconButton>
        </div>
      </div>
      <div
        ref={viewport}
        className="aui-mermaid-expanded"
        data-panning={panning}
        tabIndex={0}
        onPointerDown={onPointerDown}
      >
        <img
          src={diagram.src}
          alt={label}
          draggable={false}
          style={{
            width: diagram.width * scale,
            height: diagram.height * scale,
          }}
        />
      </div>
    </>
  );
}

export function MermaidDiagram({
  code,
  streaming,
  className,
  components: { Pre, Code },
}: Pick<SyntaxHighlighterProps, "code" | "components"> & {
  streaming: boolean;
  className: string;
}) {
  const { t } = useAppTranslation();
  const [theme, setTheme] = useState(readTheme);
  const [result, setResult] = useState<{
    key: string;
    diagram?: RenderedDiagram;
    failed?: boolean;
  }>();
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const key = JSON.stringify([code, theme]);
  const current = result?.key === key ? result : undefined;
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (streaming || !code.trim()) return;
    const controller = new AbortController();
    void renderMermaid(code, theme, controller.signal).then(
      (diagram) => {
        if (!controller.signal.aborted) setResult({ key, diagram });
      },
      () => {
        if (!controller.signal.aborted) setResult({ key, failed: true });
      },
    );
    return () => controller.abort();
  }, [code, streaming, theme, key]);
  useEffect(() => {
    setShowSource(false);
    setExpanded(false);
  }, [code]);

  if (streaming || !current?.diagram)
    return (
      <>
        <Pre>
          <Code>{code}</Code>
        </Pre>
        {!streaming && code.trim() && (
          <p className="aui-mermaid-status" role="status">
            {t(current?.failed ? "diagram.renderFailed" : "diagram.rendering")}
          </p>
        )}
      </>
    );

  return (
    <>
      <div className={`${className} aui-mermaid`}>
        <div className="aui-mermaid-actions">
          <TooltipIconButton
            tooltip={t(
              showSource ? "diagram.showDiagram" : "diagram.showSource",
            )}
            onClick={() => setShowSource((value) => !value)}
            aria-pressed={showSource}
          >
            {showSource ? <EyeIcon /> : <CodeIcon />}
          </TooltipIconButton>
          <TooltipIconButton
            ref={expandButton}
            tooltip={t("diagram.expand")}
            onClick={() => setExpanded(true)}
          >
            <Maximize2Icon />
          </TooltipIconButton>
        </div>
        {showSource ? (
          <pre className="aui-mermaid-source">
            <code>{code}</code>
          </pre>
        ) : (
          <img
            src={current.diagram.src}
            alt={t("diagram.preview")}
            width={current.diagram.width}
            height={current.diagram.height}
          />
        )}
      </div>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          className="aui-mermaid-dialog"
          initialFocus={viewport}
          finalFocus={expandButton}
        >
          <DiagramViewer
            diagram={current.diagram}
            label={t("diagram.preview")}
            viewport={viewport}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
