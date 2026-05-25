import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import mdx from "@astrojs/mdx";

const SITE_URL = process.env.SITE_URL || "https://sync-worktrees.dev";

export default defineConfig({
  site: SITE_URL,
  integrations: [
    tailwind({ applyBaseStyles: false }),
    mdx(),
    sitemap(),
  ],
  markdown: {
    shikiConfig: {
      themes: { light: "github-light", dark: "github-dark-default" },
      wrap: true,
    },
  },
  build: {
    inlineStylesheets: "auto",
  },
  prefetch: {
    prefetchAll: false,
  },
});
