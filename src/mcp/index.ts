import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { RepositoryContext } from "./context";
import { createServer } from "./server";

import type { DiscoveredRepoContext } from "./context";

async function main(): Promise<void> {
  const context = new RepositoryContext();

  const configPath = process.env.SYNC_WORKTREES_CONFIG;
  if (configPath) {
    try {
      await context.loadConfig(configPath);
      process.stderr.write(`[sync-worktrees-mcp] Loaded config: ${configPath}\n`);
    } catch (err) {
      process.stderr.write(`[sync-worktrees-mcp] Failed to load SYNC_WORKTREES_CONFIG: ${(err as Error).message}\n`);
    }
  }

  let discovered: DiscoveredRepoContext | null = null;
  try {
    discovered = await context.detectFromPath(process.cwd());
    if (discovered.isWorktree) {
      process.stderr.write(
        `[sync-worktrees-mcp] Auto-detected ${discovered.kind} worktree at ${discovered.currentWorktreePath} (branch: ${discovered.currentBranch})\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`[sync-worktrees-mcp] Auto-detect failed: ${(err as Error).message}\n`);
  }

  const server = createServer(context, { discovered });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[sync-worktrees-mcp] Fatal error: ${(err as Error).message}\n`);
  process.exit(1);
});
