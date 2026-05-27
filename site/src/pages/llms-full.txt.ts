import type { APIRoute } from "astro";
import { getCollection, getEntry } from "astro:content";
import { mdToPlainText } from "../lib/markdown-inline";
import readme from "../../../README.md?raw";

const byOrder = (a: { data: { order: number } }, b: { data: { order: number } }) => a.data.order - b.data.order;

export const GET: APIRoute = async () => {
  const p = (await getEntry("positioning", "main"))!.data;
  const c = (await getEntry("commands", "main"))!.data;
  const features = (await getCollection("features")).sort(byOrder);
  const ps = (await getCollection("problemSolution")).sort(byOrder);
  const clients = (await getCollection("clients")).sort(byOrder);
  const tools = (await getCollection("mcpTools")).sort(byOrder);
  const faqs = (await getCollection("faq")).sort(byOrder);

  const lines = [
    "# sync-worktrees — full landing-page text",
    "",
    p.llmsFullIntro,
    "",
    "---",
    "",
    "## Landing-page copy",
    "",
    `# ${p.heroHeadlineLine1} ${p.heroHeadlineLine2}`,
    "",
    `sync-worktrees ${mdToPlainText(p.heroSubhead)}`,
    "",
    mdToPlainText(p.heroDiskNote),
    "",
    "## The problem",
    "",
    "Without sync-worktrees:",
    ...ps.filter((e) => e.data.side === "without").map((e) => `- ${mdToPlainText(e.data.text)}`),
    "",
    "With sync-worktrees:",
    ...ps.filter((e) => e.data.side === "with").map((e) => `- ${mdToPlainText(e.data.text)}`),
    "",
    "## Features",
    "",
    ...features.map((f) => `- **${f.data.title}** — ${mdToPlainText(f.data.body)}`),
    "",
    "## Quick start",
    "",
    "```",
    c.npmInstall,
    c.init,
    c.runTui,
    "```",
    "",
    "For CI or scripted runs, add --runOnce.",
    "",
    "## AI agents",
    "",
    "sync-worktrees ships a Model Context Protocol server (sync-worktrees-mcp) that any MCP client can speak to over stdio. Setup per client:",
    "",
    ...clients.flatMap((x) => {
      const code = x.data.useStandardJson ? c.standardJson : (x.data.code ?? c.claudeMcpAdd);
      return [`### ${x.data.label}`, "", x.data.hint, "", `\`\`\`${x.data.lang}`, code, "```", ""];
    }),
    "### MCP tools",
    "",
    ...tools.map((t) => `- \`${t.data.name}\` — ${t.data.desc}`),
    "",
    "---",
    "",
    "## FAQ",
    "",
    ...faqs.flatMap((e) => [`### ${e.data.question}`, "", (e.body ?? "").trim(), ""]),
    "---",
    "",
    "## README (canonical)",
    "",
    readme.trim(),
    "",
  ];

  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
