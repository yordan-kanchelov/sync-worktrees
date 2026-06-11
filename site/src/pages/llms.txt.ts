import type { APIRoute } from "astro";
import { getCollection, getEntry } from "astro:content";
import { faqUrl } from "../lib/faq";

const repo = "https://github.com/yordan-kanchelov/sync-worktrees";
const site = "https://sync-worktrees.com";

export const GET: APIRoute = async () => {
  const p = (await getEntry("positioning", "main"))!.data;
  const c = (await getEntry("commands", "main"))!.data;
  const clients = (await getCollection("clients")).sort((a, b) => a.data.order - b.data.order);
  const clientList = clients.map((x) => x.data.label).join(", ");
  const faqs = (await getCollection("faq")).sort((a, b) => a.data.order - b.data.order);
  const faqLinks = faqs.map((e) => `- [${e.data.question}](${site}${faqUrl(e.id)})`).join("\n");

  const text = `# sync-worktrees

> ${p.llmsSummary}

sync-worktrees keeps every branch checked out as its own folder — one folder per branch, shared Git object storage underneath — and ships an MCP server (\`sync-worktrees-mcp\`) so AI tools like ${clientList} can list, create, inspect, and sync worktrees through tool calls. A per-repo clone mode instead keeps a single branch checked out at a fixed path (no \`.bare/\`, no per-branch folders) — for monorepo sibling dependencies that expect fixed relative paths. Runs as a one-shot sync or an interactive Ink-based TUI with cron scheduling. MIT licensed, Node 22+, macOS and Linux.

## Docs

- [README](${repo}/blob/main/README.md): Full installation, configuration reference, MCP integration, and TUI keybindings.
- [Full landing-page text](${site}/llms-full.txt): Hero copy, problem statement, feature descriptions, every MCP config snippet, and FAQ — all as plain text.
- [Example config](${repo}/blob/main/sync-worktrees.config.example.js): Annotated reference covering worktree mode, clone mode, filtering, retry, and cron scheduling.

## FAQ

${faqLinks}

## Install

- For developers: \`${c.npmInstall}\`
- For AI agents (Claude Code): \`${c.claudeMcpAdd}\`
- For AI agents (standard MCP config): \`npx -y -p sync-worktrees sync-worktrees-mcp\` via stdio in any MCP client.

## Optional

- [npm package](https://www.npmjs.com/package/sync-worktrees)
- [Changelog](${repo}/blob/main/CHANGELOG.md)
- [Issues](${repo}/issues)
`;

  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
