import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";
import mdx from "@astrojs/mdx";

const SITE_URL = process.env.SITE_URL || "https://sync-worktrees.com";

export default defineConfig({
  site: SITE_URL,
  integrations: [
    mdx(),
    sitemap(),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
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
