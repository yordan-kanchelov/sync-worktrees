import { Writable } from "node:stream";

import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";

import { warnIfUnitTestShortcutEnabled } from "../utils/unit-test-shortcut";

import { RepositoryContext } from "./context";
import { createServer } from "./server";

import type { DiscoveredRepoContext } from "./context";

/**
 * stdout carries JSON-RPC only. Hands the transport a private handle on the
 * real stdout, then sends every other stdout write (a config's console.log,
 * a dependency's banner) to stderr.
 */
function claimStdoutForTransport(): Writable {
  const realWrite = process.stdout.write.bind(process.stdout);
  const wire = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      realWrite(chunk, (err) => callback(err ?? null));
    },
  });
  // A write error reaches the transport through `wire`; without a listener
  // here the same error would also crash the process.
  process.stdout.on("error", () => {});
  process.stdout.write = process.stderr.write.bind(process.stderr);
  console.log = console.info = console.debug = console.error;
  return wire;
}

async function main(): Promise<void> {
  const wire = claimStdoutForTransport();
  warnIfUnitTestShortcutEnabled((message) => process.stderr.write(`[sync-worktrees-mcp] ${message}\n`));
  const context = new RepositoryContext();

  let discovered: DiscoveredRepoContext | null = null;
  try {
    discovered = await context.detectFromPath(process.cwd());
    if (discovered.configPath) {
      process.stderr.write(`[sync-worktrees-mcp] Auto-loaded config: ${discovered.configPath}\n`);
    }
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
      transport: new StdioServerTransport(process.stdin, wire),
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

  const shutdown = (): void => {
    void handle.close().finally(() => process.exit(0));
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, shutdown);
  }
  // The stdio transport ignores EOF; a retry backoff or lock refresh timer
  // would keep a disconnected server alive. Closing aborts in-flight calls.
  process.stdin.once("end", shutdown);
}

main().catch((err) => {
  process.stderr.write(`[sync-worktrees-mcp] Fatal error: ${(err as Error).message}\n`);
  process.exit(1);
});
