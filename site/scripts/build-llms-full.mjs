import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(__dirname, "..");
const repoRoot = resolve(siteRoot, "..");

const readmePath = resolve(repoRoot, "README.md");
const faqPath = resolve(siteRoot, "src/content/faq.mdx");
const heroPath = resolve(siteRoot, "src/content/copy.md");
const outPath = resolve(siteRoot, "dist/llms-full.txt");

const readme = await readFile(readmePath, "utf8");
const faq = await readFile(faqPath, "utf8");
const copy = await readFile(heroPath, "utf8").catch(() => "");

const stripFrontmatter = (text) =>
  text.replace(/^---\n[\s\S]*?\n---\n/, "").trim();

const stripHtml = (text) =>
  text
    .replace(/<details>\s*<summary>([^<]+)<\/summary>/g, "\n### $1\n")
    .replace(/<\/details>/g, "")
    .replace(/<[^>]+>/g, "");

const sections = [
  "# sync-worktrees — full landing-page text",
  "",
  "This file is the plain-text companion to https://sync-worktrees.dev — designed for LLM crawlers and training pipelines. It contains the landing-page hero copy, problem statement, feature descriptions, MCP configuration snippets for every supported AI tool, the full FAQ, and the canonical README in that order.",
  "",
  "---",
  "",
  "## Landing-page copy",
  "",
  stripFrontmatter(copy),
  "",
  "---",
  "",
  "## FAQ",
  "",
  stripFrontmatter(faq)
    .replace(/<Question>/g, "### ")
    .replace(/<\/Question>/g, "")
    .replace(/<Answer>/g, "")
    .replace(/<\/Answer>/g, ""),
  "",
  "---",
  "",
  "## README (canonical)",
  "",
  stripHtml(readme),
];

const output = sections.join("\n").replace(/\n{3,}/g, "\n\n");

await writeFile(outPath, output, "utf8");
console.log(`wrote ${outPath} (${output.length} bytes)`);
