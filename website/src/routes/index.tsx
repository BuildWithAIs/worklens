import { createFileRoute } from "@tanstack/react-router";
import { FAQ } from "@/components/home/faq";
import { Features } from "@/components/home/features";
import { GettingStarted } from "@/components/home/getting-started";
import { Hero } from "@/components/home/hero";
import { ProductPreview } from "@/components/home/product-preview";
import { siteConfig } from "@/config/site";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: siteConfig.title },
      { name: "description", content: siteConfig.description },
      { property: "og:type", content: "website" },
      { property: "og:locale", content: "zh_CN" },
      { property: "og:title", content: siteConfig.title },
      {
        property: "og:description",
        content: siteConfig.socialDescription,
      },
      { property: "og:url", content: `${siteConfig.url}/` },
      {
        property: "og:image",
        content: `${siteConfig.url}/assets/worklens.png`,
      },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: `${siteConfig.url}/` }],
  }),
  component: Home,
});

function Home() {
  return (
    <main id="main">
      <Hero />
      <ProductPreview />
      <Features />
      <GettingStarted />
      <FAQ />
    </main>
  );
}
