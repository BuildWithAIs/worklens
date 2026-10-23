import { syntaxHighlighter as hljs } from "@/lib/syntax-highlight";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import {
  memo,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import {
  GlobeIcon,
  DownloadIcon,
  XIcon,
  EyeIcon,
  CodeIcon,
  ChevronDownIcon,
  FolderSearch,
  ChromeIcon,
} from "lucide-react";
import { Hint } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useAppTranslation } from "@/i18n";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { inspectConversationFile } from "@/lib/file-inspection-queue";
import { useAuiState } from "@assistant-ui/react";

type Artifact = {
  /** Card that requested an automatic preview. */
  source?: string;
  path?: string;
  code: string;
  title: string;
  filename: string;
  trigger: HTMLElement;
  manual: boolean;
};
type AutoPreview = {
  preview: () => void;
  element: () => HTMLElement | null;
};
const Context = createContext<{
  conversationId?: string;
  outputPaths: readonly string[];
  open: (artifact: Artifact) => void;
  register: (id: string, candidate: AutoPreview) => () => void;
} | null>(null);

export function useArtifactWorkspace() {
  return useContext(Context);
}

export function isHtmlArtifact(language: string, code: string) {
  return (
    /^html?$/i.test(language) &&
    /^\s*(?:<!doctype html[^>]*>\s*)?<html[\s>]/i.test(code) &&
    /<\/html>\s*$/i.test(code)
  );
}

// Static, opaque-origin document. Network access, scripts, frames and navigation
// are unavailable; the original source remains available for viewing/download.
export function staticHtml(code: string) {
  const doc = new DOMParser().parseFromString(code, "text/html");
  doc
    .querySelectorAll(
      "script,iframe,frame,frameset,object,embed,base,meta,link",
    )
    .forEach((node) => node.remove());
  doc.querySelectorAll("*").forEach((node) => {
    for (const attribute of [...node.attributes]) {
      if (
        /^on/i.test(attribute.name) ||
        ["href", "action", "formaction", "target", "srcdoc", "ping"].includes(
          attribute.name,
        )
      )
        node.removeAttribute(attribute.name);
    }
  });
  const policy = doc.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
  doc.head.prepend(policy);
  return "<!doctype html>" + doc.documentElement.outerHTML;
}

function downloadHtml(code: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob([code], { type: "text/html;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ArtifactCard({
  code,
  path,
  label,
}: {
  code?: string;
  path?: string;
  label?: string;
}) {
  const context = useContext(Context);
  const { t } = useAppTranslation();
  const id = useId();
  const filename = path?.split(/[\\/]/).pop() || "web-preview.html";
  const [resolvedPath, setResolvedPath] = useState(path);
  useEffect(() => {
    const controller = new AbortController();
    if (path && context?.conversationId)
      void inspectConversationFile(
        context.conversationId,
        path,
        controller.signal,
      )
        .then((file) => {
          if (!controller.signal.aborted && file) setResolvedPath(file.path);
        })
        .catch(() => {});
    return () => {
      controller.abort();
    };
  }, [path, context?.conversationId]);
  const title = useMemo(
    () =>
      label ||
      (code
        ? new DOMParser().parseFromString(code, "text/html").title.trim() ||
          t("htmlArtifact.webPreview")
        : filename),
    [code, label, filename, t],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const action = async (download = false, manual = true) => {
    if (!context || busy.current) return;
    const current = ++generation.current;
    busy.current = true;
    setLoading(true);
    setError(false);
    try {
      const file = path
        ? await window.worklens.invoke("conversationFile", {
            id: context.conversationId!,
            path,
            action: "preview",
          })
        : undefined;
      if (file?.issue) {
        if (current === generation.current)
          toast.add({ type: "error", title: t(`localFiles.${file.issue}`) });
        return;
      }
      const html = code ?? file?.content;
      if (html === undefined) throw new Error("HTML unavailable");
      if (current !== generation.current || !button.current) return;
      if (download) downloadHtml(html, filename);
      else
        context.open({
          path,
          code: html,
          title,
          filename,
          trigger: button.current,
          manual,
          source: id,
        });
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  };
  const auto = useRef(() => {});
  auto.current = () => {
    void action(false, false);
  };
  // Only the newest reply's cards are automatic preview candidates.
  const latest = useAuiState((s) => s.message.isLast);
  useEffect(
    () =>
      latest
        ? context?.register(id, {
            preview: () => auto.current(),
            element: () => button.current,
          })
        : undefined,
    [context?.register, id, latest],
  );
  return (
    <span className="artifact-card-container">
      <span
        data-slot={path ? "html-file-card" : "html-artifact-card"}
        className="html-artifact-card"
        aria-busy={loading}
      >
        <Hint
          disabled={!path}
          content={<span className="link-target-hint">{resolvedPath}</span>}
        >
          <Button
            ref={button}
            variant="ghost"
            className="artifact-card-open"
            aria-label={t("htmlArtifact.openPreview") + ": " + title}
            onClick={() => void action()}
          >
            <span className="artifact-card-icon">
              <GlobeIcon aria-hidden="true" className="size-5" />
            </span>
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate font-medium">{title}</span>
              <span className="block text-sm text-muted-foreground">
                Code · HTML
              </span>
            </span>
          </Button>
        </Hint>
        <span className="artifact-split-button">
          <Button
            variant="outline"
            size="sm"
            className="artifact-card-download"
            disabled={loading}
            onClick={() => void action(true)}
          >
            {loading
              ? t("htmlArtifact.loadingPlaceholder")
              : t("htmlArtifact.download")}
          </Button>
          <ArtifactActions source={path ? { path } : { code }} />
        </span>
      </span>
      {error && (
        <span role="alert" className="block text-sm text-muted-foreground">
          {t("htmlArtifact.unavailableDescription")}
        </span>
      )}
    </span>
  );
}
export function HtmlArtifactCard({ code }: { code: string }) {
  return <ArtifactCard code={code} />;
}
export function HtmlFileCard({
  path,
  label,
}: {
  path: string;
  label?: string;
}) {
  return <ArtifactCard path={path} label={label} />;
}

const noOutputs: readonly string[] = [];

export function HtmlArtifactWorkspace({
  children,
  conversationId,
  running = false,
  outputPaths = noOutputs,
}: PropsWithChildren<{
  conversationId?: string;
  running?: boolean;
  outputPaths?: readonly string[];
}>) {
  const { t } = useAppTranslation();
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [mode, setMode] = useState<"preview" | "code">("preview");
  const closeButton = useRef<HTMLButtonElement>(null);
  const registry = useRef(new Map<string, AutoPreview>());
  const wasRunning = useRef(running);
  const autoPending = useRef(false);
  const autoTarget = useRef<string | undefined>(undefined);
  const current = useRef(artifact);
  current.current = artifact;
  const previewLatest = useCallback(() => {
    if (!autoPending.current) return;
    if (!window.matchMedia("(min-width: 1101px)").matches) {
      autoPending.current = false;
      return;
    }
    // Verified cards register asynchronously and in any order. Until the user
    // takes over, follow the last card in the reply rather than the first ready.
    let target: [string, HTMLElement] | undefined;
    for (const [id, candidate] of registry.current) {
      const element = candidate.element();
      if (
        element?.isConnected &&
        (!target ||
          target[1].compareDocumentPosition(element) &
            Node.DOCUMENT_POSITION_FOLLOWING)
      )
        target = [id, element];
    }
    if (!target || target[0] === autoTarget.current) return;
    autoTarget.current = target[0];
    registry.current.get(target[0])!.preview();
  }, []);
  const register = useCallback(
    (id: string, candidate: AutoPreview) => {
      registry.current.set(id, candidate);
      const frame = requestAnimationFrame(previewLatest);
      return () => {
        cancelAnimationFrame(frame);
        registry.current.delete(id);
      };
    },
    [previewLatest],
  );
  useEffect(() => {
    autoPending.current = false;
  }, [conversationId]);
  useEffect(() => {
    if (running && !wasRunning.current) autoPending.current = false;
    const completed = wasRunning.current && !running;
    wasRunning.current = running;
    if (!completed) return;
    autoPending.current = true;
    autoTarget.current = undefined;
    const frame = requestAnimationFrame(previewLatest);
    return () => cancelAnimationFrame(frame);
  }, [running, previewLatest]);
  const document = useMemo(
    () => (artifact ? staticHtml(artifact.code) : ""),
    [artifact],
  );
  const close = () => {
    autoPending.current = false;
    const trigger = artifact?.trigger;
    setArtifact(null);
    requestAnimationFrame(() => trigger?.isConnected && trigger.focus());
  };
  useEffect(() => {
    if (artifact?.manual) closeButton.current?.focus();
  }, [artifact]);
  const open = useCallback((item: Artifact) => {
    if (item.manual) autoPending.current = false;
    // A slower, superseded automatic preview must not replace the latest one.
    else if (!autoPending.current || item.source !== autoTarget.current) return;
    else if (
      current.current?.path === item.path &&
      current.current?.code === item.code
    )
      return;
    setArtifact(item);
    setMode("preview");
  }, []);
  // Every message's markdown reads this context; a stable value keeps them
  // from re-rendering whenever the thread around them does.
  const workspace = useMemo(
    () => ({ conversationId, outputPaths, register, open }),
    [conversationId, outputPaths, register, open],
  );
  return (
    <Context.Provider value={workspace}>
      <div className="artifact-workspace" data-preview-open={!!artifact}>
        <div className="artifact-chat">{children}</div>
        {artifact && (
          <section
            className="artifact-panel"
            aria-label={t("htmlArtifact.webPreview")}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                close();
              }
            }}
          >
            <header className="artifact-toolbar">
              <span
                className="artifact-view-switch"
                data-mode={mode}
                role="group"
                aria-label={t("htmlArtifact.displayMode")}
              >
                <TooltipIconButton
                  tooltip={t("htmlArtifact.preview")}
                  aria-pressed={mode === "preview"}
                  onClick={() => setMode("preview")}
                >
                  <EyeIcon />
                </TooltipIconButton>
                <TooltipIconButton
                  tooltip={t("htmlArtifact.code")}
                  aria-pressed={mode === "code"}
                  onClick={() => setMode("code")}
                >
                  <CodeIcon />
                </TooltipIconButton>
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">
                {artifact.title}
                <span className="text-muted-foreground font-normal">
                  {" "}
                  · HTML
                </span>
              </span>
              <span className="artifact-split-button">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => copyToClipboard(artifact.code)}
                >
                  {isCopied ? t("common.copied") : t("common.copy")}
                </Button>
                <ArtifactActions
                  source={
                    artifact.path
                      ? { path: artifact.path }
                      : { code: artifact.code }
                  }
                  download={() =>
                    downloadHtml(artifact.code, artifact.filename)
                  }
                  nativeActions={false}
                />
              </span>
              <TooltipIconButton
                ref={closeButton}
                tooltip={t("htmlArtifact.closePreview")}
                onClick={close}
              >
                <XIcon />
              </TooltipIconButton>
            </header>
            <div className="artifact-pages">
              <div className="artifact-page" hidden={mode !== "preview"}>
                <iframe
                  title={artifact.title}
                  sandbox=""
                  referrerPolicy="no-referrer"
                  srcDoc={document}
                />
              </div>
              <div className="artifact-page" hidden={mode !== "code"}>
                <ArtifactCode code={artifact.code} />
              </div>
            </div>
          </section>
        )}
      </div>
    </Context.Provider>
  );
}

function ArtifactActions({
  source,
  download,
  nativeActions = true,
}: {
  source: { path?: string; code?: string };
  download?: () => void;
  nativeActions?: boolean;
}) {
  const context = useContext(Context);
  const { t } = useAppTranslation();
  const mac = navigator.platform.startsWith("Mac");
  const perform = async (action: "chrome" | "reveal") => {
    if (!context?.conversationId) return;
    try {
      if (source.path) {
        const result = await window.worklens.invoke("conversationFile", {
          id: context.conversationId,
          path: source.path,
          action,
        });
        if (result.issue) throw new Error(result.issue);
        return;
      }
      await window.worklens.invoke("htmlFileAction", {
        id: context.conversationId,
        ...(source.path ? { path: source.path } : { code: source.code }),
        action,
      });
    } catch {
      toast.add({
        type: "error",
        title:
          action === "chrome"
            ? t("htmlArtifact.chromeOpenError")
            : t("htmlArtifact.fileMissingError"),
      });
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="artifact-menu-trigger"
            aria-label={t("htmlArtifact.artifactActions")}
          />
        }
      >
        <ChevronDownIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          {download && (
            <DropdownMenuItem onClick={download}>
              <DownloadIcon />
              {t("htmlArtifact.downloadAsHTML")}
            </DropdownMenuItem>
          )}
          {nativeActions && (
            <DropdownMenuItem
              disabled={!mac}
              onClick={() => void perform("chrome")}
            >
              <ChromeIcon />
              {t("htmlArtifact.openInGoogleChrome")}
            </DropdownMenuItem>
          )}
          {nativeActions && (
            <DropdownMenuItem onClick={() => void perform("reveal")}>
              <FolderSearch />
              {mac
                ? t("htmlArtifact.showInFinder")
                : t("htmlArtifact.showInFolder")}
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ArtifactCode = memo(function ArtifactCode({ code }: { code: string }) {
  const highlighted = useMemo(
    () => hljs.highlight(code, { language: "xml" }).value,
    [code],
  );
  return (
    <div className="artifact-source" tabIndex={0}>
      <div className="artifact-line-numbers" aria-hidden="true">
        {code.split("\n").map((_, index) => (
          <span key={index}>{index + 1}</span>
        ))}
      </div>
      <pre>
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
});
