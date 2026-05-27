import type { APIRoute } from "astro";
import { getCollection, getEntry } from "astro:content";

const repo = "https://github.com/yordan-kanchelov/sync-worktrees";

export const GET: APIRoute = async () => {
  const p = (await getEntry("positioning", "main"))!.data;
  const c = (await getEntry("commands", "main"))!.data;
  const clients = (await getCollection("clients")).sort((a, b) => a.data.order - b.data.order);
  const clientList = clients.map((x) => x.data.label).join(", ");

  const text = `# sync-worktrees

> ${p.llmsSummary}

sync-worktrees keeps every branch checked out as its own folder — one folder per branch, shared Git object storage underneath — and ships an MCP server (\`sync-worktrees-mcp\`) so AI tools like ${clientList} can list, create, inspect, and sync worktrees through tool calls. Runs as a one-shot sync or an interactive Ink-based TUI with cron scheduling. MIT licensed, Node 22+, macOS and Linux.

## Docs

- [README](${repo}/blob/main/README.md): Full installation, configuration reference, MCP integration, and TUI keybindings.
- [Full landing-page text](https://sync-worktrees.com/llms-full.txt): Hero copy, problem statement, feature descriptions, every MCP config snippet, and FAQ — all as plain text.
- [Architecture notes](${repo}/tree/main/docs): Engineering design docs covering sync planning, MCP selection state, retry policy, and structured outcomes.
- [Example config](${repo}/blob/main/sync-worktrees.config.example.js): Annotated reference covering worktree mode, clone mode, filtering, retry, and cron scheduling.

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
