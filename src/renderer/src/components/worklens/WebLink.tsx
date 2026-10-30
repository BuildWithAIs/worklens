import {
  Children,
  isValidElement,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { Hint } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import { shortUrl } from "@/lib/link-label";
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/i18n";

export function isWebUrl(value: unknown): value is string {
  if (typeof value !== "string" || !/^https?:\/\/[^\s]+$/i.test(value))
    return false;
  try {
    return Boolean(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function WebLink({
  className,
  href,
  onClick,
  ...props
}: ComponentPropsWithoutRef<"a">) {
  const { t } = useAppTranslation();
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
    isWebUrl(text) &&
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
  return href && /^https?:\/\//i.test(href) ? (
    <Hint content={<span className="link-target-hint">{href}</span>}>
      {link}
    </Hint>
  ) : (
    link
  );
}
