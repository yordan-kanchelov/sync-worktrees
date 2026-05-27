import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { glob, file } from "astro/loaders";

const faq = defineCollection({
  loader: glob({ pattern: "*.md", base: "./src/content/faq" }),
  schema: z.object({
    question: z.string(),
    order: z.number(),
  }),
});

const positioning = defineCollection({
  loader: file("./src/content/data/positioning.yaml"),
  schema: z.object({
    heroHeadlineLine1: z.string(),
    heroHeadlineLine2: z.string(),
    heroSubhead: z.string(),
    heroDiskNote: z.string(),
    metaTitle: z.string(),
    metaDescription: z.string(),
    ogImageAlt: z.string(),
    ctaHeadline: z.string(),
    ctaSubhead: z.string(),
    llmsSummary: z.string(),
    llmsFullIntro: z.string(),
  }),
});

const commands = defineCollection({
  loader: file("./src/content/data/commands.yaml"),
  schema: z.object({
    npmInstall: z.string(),
    claudeMcpAdd: z.string(),
    init: z.string(),
    runTui: z.string(),
    runOnce: z.string(),
    standardJson: z.string(),
  }),
});

const clients = defineCollection({
  loader: file("./src/content/data/clients.yaml"),
  schema: z.object({
    label: z.string(),
    lang: z.enum(["bash", "json"]),
    code: z.string().optional(),
    useStandardJson: z.boolean().default(false),
    hint: z.string(),
    order: z.number(),
  }),
});

const mcpTools = defineCollection({
  loader: file("./src/content/data/mcp-tools.yaml"),
  schema: z.object({
    name: z.string(),
    desc: z.string(),
    order: z.number(),
  }),
});

const features = defineCollection({
  loader: file("./src/content/data/features.yaml"),
  schema: z.object({
    icon: z.string(),
    title: z.string(),
    body: z.string(),
    order: z.number(),
  }),
});

const problemSolution = defineCollection({
  loader: file("./src/content/data/problem-solution.yaml"),
  schema: z.object({
    side: z.enum(["without", "with"]),
    text: z.string(),
    order: z.number(),
  }),
});

export const collections = { faq, positioning, commands, clients, mcpTools, features, problemSolution };
