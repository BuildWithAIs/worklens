"use client";

import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import {
  HtmlArtifactCard,
  HtmlFileCard,
  isHtmlArtifact,
  useArtifactWorkspace,
} from "@/components/worklens/HtmlArtifact";
import remarkGfm from "remark-gfm";
import { remarkCjkAutolinks } from "@/lib/remark-cjk-autolinks";
import { remarkLocalFiles } from "@/lib/remark-local-files";
import { LocalFileLink } from "@/components/worklens/LocalFileLink";
import { shortUrl } from "@/lib/link-label";
import {
  localReferences,
  fileReferenceAliases,
} from "../../../../../shared/file-references";
import { Hint } from "@/components/ui/tooltip";
import {
  type ComponentPropsWithoutRef,
  type FC,
  memo,
  createContext,
  useContext,
  useMemo,
  useEffect,
  useState,
  useRef,
  Children,
  isValidElement,
  type ReactNode,
} from "react";
import {
  useAuiState,
  useMessagePartText,
  type TextMessagePartProps,
} from "@assistant-ui/react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/i18n";
import { toast } from "@/components/ui/toast";

type MarkdownTextProps = Partial<TextMessagePartProps> & {
  compact?: boolean;
  components?: Parameters<typeof memoizeMarkdownComponents>[0];
};

const useShallowStable = <T extends Record<string, unknown> | undefined>(
  value: T,
): T => {
  const ref = useRef(value);
  if (value !== ref.current) {
    const prev = ref.current;
    const stable =
      value !== undefined &&
      prev !== undefined &&
      Object.keys(prev).length === Object.keys(value).length &&
      Object.keys(value).every((key) => prev[key] === value[key]);
    if (!stable) ref.current = value;
  }
  return ref.current;
};

const MarkdownTextImpl: FC<MarkdownTextProps> = ({ components, compact }) => {
  const assistant = useAuiState((s) => s.message.role === "assistant");
  const running = useAuiState((s) => s.thread.isRunning);
  const { text } = useMessagePartText();
  const workspace = useArtifactWorkspace();
  const conversationId = workspace?.conversationId;
  const outputs = JSON.stringify(workspace?.outputPaths ?? []);
  const candidates = JSON.stringify(
    assistant
      ? localReferences(
          text,
          fileReferenceAliases(workspace?.outputPaths ?? []),
        ).sort()
      : [],
  );
  const [verification, setVerification] = useState<{
    conversationId: string;
    paths: ReadonlySet<string>;
    available: ReadonlySet<string>;
  }>();
  useEffect(() => {
    let active = true;
    if (!conversationId || !assistant) return;
    const paths: string[] = JSON.parse(candidates);
    void Promise.all(
      paths.map(async (path) => {
        try {
          const file = await window.worklens.invoke("conversationFile", {
            id: conversationId,
            path,
            action: "inspect",
          });
          return file && !file.issue
            ? { path, produced: file.produced }
            : undefined;
        } catch {
          return undefined;
        }
      }),
    ).then((results) => {
      if (active)
        setVerification({
          conversationId,
          paths: new Set(
            results.flatMap((file) => (file?.produced ? [file.path] : [])),
          ),
          available: new Set(
            results.flatMap((file) => (file ? [file.path] : [])),
          ),
        });
    });
    return () => {
      active = false;
    };
  }, [assistant, conversationId, candidates, running, outputs]);
  const producedPaths =
    verification?.conversationId === conversationId
      ? (verification?.paths ?? new Set<string>())
      : new Set<string>();
  const availablePaths =
    verification?.conversationId === conversationId
      ? (verification?.available ?? new Set<string>())
      : new Set<string>();
  const stableComponents = useShallowStable(components);
  const markdownComponents = useMemo(() => {
    if (!stableComponents) return defaultComponents;
    return {
      ...defaultComponents,
      ...memoizeMarkdownComponents(stableComponents),
    };
  }, [stableComponents]);

  return (
    <MarkdownTextPrimitive
      remarkPlugins={[
        remarkGfm,
        remarkCjkAutolinks,
        [
          remarkLocalFiles,
          { enabled: assistant, producedPaths, availablePaths },
        ],
      ]}
      className={cn(
        "aui-md font-normal antialiased",
        compact ? "text-sm leading-6" : "text-[14px] leading-[1.7]",
      )}
      components={markdownComponents}
      defer
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

const plainTextLanguages = new Set(["text", "plaintext", "txt", "plain"]);

const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { t } = useAppTranslation();
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const ready = useAuiState(
    (s) =>
      s.message.role === "assistant" && s.message.status?.type !== "running",
  );
  const onCopy = () => {
    if (!code || isCopied) return;
    copyToClipboard(code);
  };

  if (ready && isHtmlArtifact(language ?? "", code))
    return <HtmlArtifactCard code={code} />;

  const showLanguage = Boolean(
    language?.trim() && !plainTextLanguages.has(language.trim().toLowerCase()),
  );

  return (
    <div className="aui-code-header-root" data-language={showLanguage}>
      {showLanguage && (
        <span className="aui-code-header-language text-muted-foreground font-medium lowercase">
          {language}
        </span>
      )}
      <TooltipIconButton
        className="aui-code-copy"
        tooltip={t("common.copy")}
        onClick={onCopy}
      >
        {!isCopied && (
          <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
        )}
        {isCopied && (
          <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
        )}
      </TooltipIconButton>
    </div>
  );
};

const InsideChatLink = createContext(false);

function isInlineWebUrl(text: string) {
  if (!/^https?:\/\/[^\s]+$/i.test(text)) return false;
  try {
    return Boolean(new URL(text).hostname);
  } catch {
    return false;
  }
}

function ChatLink({
  className,
  href,
  onClick,
  "data-local-path": localPath,
  "data-local-label": localLabel,
  "data-local-description": localDescription,
  "data-local-actions": localActionMode,
  ...props
}: ComponentPropsWithoutRef<"a"> & {
  "data-local-path"?: string;
  "data-local-label"?: string;
  "data-local-description"?: string;
  "data-local-actions"?: string;
}) {
  const { t } = useAppTranslation();
  const localActions = localActionMode !== "false";
  if (localPath)
    return localActions && /\.html?$/i.test(localPath) ? (
      <HtmlFileCard path={localPath} label={localLabel} />
    ) : (
      <LocalFileLink path={localPath} label={localLabel} actions={localActions}>
        {localDescription ? props.children : undefined}
      </LocalFileLink>
    );
  const textOf = (node: ReactNode): string =>
    Children.toArray(node)
      .map((item) =>
        typeof item === "string"
          ? item
          : isValidElement<{ children?: ReactNode }>(item)
            ? textOf(item.props.children)
            : "",
      )
      .join("");
  const text = textOf(props.children);
  const shortened =
    href &&
    isInlineWebUrl(text) &&
    text.replace(/\/$/, "") === href.replace(/\/$/, "")
      ? shortUrl(text)
      : text;
  const link = (
    <a
      {...props}
      children={shortened !== text ? shortened : props.children}
      href={href}
      className={cn(
        "aui-md-a text-primary hover:text-primary/80 underline underline-offset-2",
        className,
      )}
      onClick={(event) => {
        if (!href || !/^https?:\/\//i.test(href)) {
          onClick?.(event);
          return;
        }
        event.preventDefault();
        void window.worklens.invoke("external", { url: href }).catch(() => {
          toast.add({
            type: "error",
            title: t("chatLinks.openFailed"),
            timeout: 0,
            priority: "high",
          });
        });
      }}
    />
  );
  return (
    <InsideChatLink.Provider value={true}>
      {href && /^https?:\/\//i.test(href) ? (
        <Hint content={<span className="link-target-hint">{href}</span>}>
          {link}
        </Hint>
      ) : (
        link
      )}
    </InsideChatLink.Provider>
  );
}

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => (
    <h1
      className={cn(
        "aui-md-h1 mt-6 mb-2 scroll-m-20 text-[15px] font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn(
        "aui-md-h2 mt-5 mb-2 scroll-m-20 text-[15px] font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn(
        "aui-md-h3 mt-4 mb-2 scroll-m-20 text-sm font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }) => (
    <h4
      className={cn(
        "aui-md-h4 mt-3.5 mb-1 scroll-m-20 text-sm font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h5: ({ className, ...props }) => (
    <h5
      className={cn(
        "aui-md-h5 mt-3 mb-1 text-sm font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h6: ({ className, ...props }) => (
    <h6
      className={cn(
        "aui-md-h6 mt-3 mb-1 text-sm font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  p: ({ className, ...props }) => (
    <p
      className={cn(
        "aui-md-p my-[1em] leading-[inherit] first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  a: ChatLink,
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        "aui-md-blockquote border-muted-foreground/30 text-muted-foreground my-3 border-s-2 ps-4",
        className,
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn(
        "aui-md-ul my-[1em] ms-6 list-disc [&>li]:ps-1 [&>li+li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn(
        "aui-md-ol my-[1em] ms-6 list-decimal [&>li]:ps-1 [&>li+li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr
      className={cn("aui-md-hr border-muted-foreground/20 my-3", className)}
      {...props}
    />
  ),
  table: ({ className, ...props }) => (
    <div className="aui-md-table-wrapper my-5 overflow-x-auto">
      <table
        className={cn(
          "aui-md-table w-full border-separate border-spacing-0",
          className,
        )}
        {...props}
      />
    </div>
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "aui-md-th border-border border-b px-3 py-2.5 text-start align-top font-medium first:ps-0 last:pe-0 [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        "aui-md-td border-border/50 border-b px-3 py-2.5 text-start align-top first:ps-0 last:pe-0 [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr
      className={cn(
        "aui-md-tr m-0 p-0 [&:last-child>td]:border-b-0",
        className,
      )}
      {...props}
    />
  ),
  li: ({ className, ...props }) => (
    <li className={cn("aui-md-li leading-[inherit]", className)} {...props} />
  ),
  strong: ({ className, ...props }) => (
    <strong className={cn("aui-md-strong font-medium", className)} {...props} />
  ),
  sup: ({ className, ...props }) => (
    <sup
      className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)}
      {...props}
    />
  ),
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "aui-md-pre border-border/30 bg-muted/30 my-3 overflow-x-auto rounded-md border text-[13px] leading-relaxed",
        className,
      )}
      {...props}
    />
  ),
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    const insideLink = useContext(InsideChatLink);
    const path =
      typeof props.children === "string" ? props.children.trim() : "";
    if (!isCodeBlock && !insideLink && isInlineWebUrl(path))
      return (
        <ChatLink href={path} className="aui-md-code-link">
          <code className={cn("aui-md-inline-code", className)} {...props} />
        </ChatLink>
      );
    return (
      <code
        className={cn(!isCodeBlock && "aui-md-inline-code", className)}
        {...props}
      />
    );
  },
  CodeHeader,
});
