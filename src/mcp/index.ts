import { serveStdio } from "@modelcontextprotocol/server/stdio";

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

  const handle = serveStdio(
    () =>
      createServer(context, {
        discovered,
        configuredRepoCount: context.getConfiguredRepositoryNames().length,
      }),
    {
      // 2025-era clients are served from the same factory, with the same tools
      // and instructions. The 2026-07-28 revision keeps older revisions alive
      // for at least twelve months, and most MCP clients have not shipped
      // 2026-07-28 support yet, so rejecting them would strand every install.
      legacy: "serve",
      onerror: (err) => {
        process.stderr.write(`[sync-worktrees-mcp] Transport error: ${err.message}\n`);
      },
    },
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void handle.close().finally(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  process.stderr.write(`[sync-worktrees-mcp] Fatal error: ${(err as Error).message}\n`);
  process.exit(1);
});
