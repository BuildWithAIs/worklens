/// <reference types="vite/client" />

import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { NotFound } from "@/components/not-found";
import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";
import appCss from "@/styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#f5f4ed" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/png", href: "/assets/icon.png" },
      {
        rel: "preload",
        as: "image",
        href: "/assets/worklens.png",
        fetchPriority: "high",
      },
    ],
  }),
  notFoundComponent: NotFound,
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <HeadContent />
      </head>
      <body>
        <a className="skip" href="#main">
          跳转到正文
        </a>
        <div className="wrap">
          <SiteHeader />
          {children}
          <SiteFooter />
        </div>
        <Scripts />
      </body>
    </html>
  );
}
