import { Writable } from "node:stream";

import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";

import { warnIfUnitTestShortcutEnabled } from "../utils/unit-test-shortcut";

import { RepositoryContext } from "./context";
import { createServer } from "./server";

import type { DiscoveredRepoContext } from "./context";

function claimStdoutForTransport(): Writable {
  const realWrite = process.stdout.write.bind(process.stdout);
  const wire = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      realWrite(chunk, (err) => callback(err ?? null));
    },
  });
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
  process.stdin.once("end", shutdown);
}

main().catch((err) => {
  process.stderr.write(`[sync-worktrees-mcp] Fatal error: ${(err as Error).message}\n`);
  process.exit(1);
});
