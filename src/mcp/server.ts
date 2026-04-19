import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  handleCreateWorktree,
  handleDetectContext,
  handleGetWorktreeStatus,
  handleInitialize,
  handleListWorktrees,
  handleLoadConfig,
  handleRemoveWorktree,
  handleSetCurrentRepository,
  handleSync,
  handleUpdateWorktree,
} from "./handlers";
import { wrapHandler } from "./utils";

import type { RepositoryContext } from "./context";

export function createServer(context: RepositoryContext): McpServer {
  const server = new McpServer({
    name: "sync-worktrees",
    version: "1.0.0",
  });

  server.registerTool(
    "detect_context",
    {
      description:
        "Detect sync-worktrees structure from a path. Reads .git file, resolves bare repo, discovers all sibling worktrees. Defaults to CWD.",
      inputSchema: {
        path: z.string().optional().describe("Directory path to inspect (defaults to CWD)"),
      },
    },
    wrapHandler((params, extra) => handleDetectContext(context, params, extra)),
  );

  server.registerTool(
    "list_worktrees",
    {
      description:
        "List all worktrees with enriched status (label, divergence, safeToRemove, lastSyncAt, upstream state).",
      inputSchema: {
        repoName: z.string().optional().describe("Repository name (uses current if omitted)"),
      },
    },
    wrapHandler((params, extra) => handleListWorktrees(context, params, extra)),
  );

  server.registerTool(
    "get_worktree_status",
    {
      description:
        "Get detailed status for a single worktree (dirty files, unpushed commits, stashes, operations in progress).",
      inputSchema: {
        path: z.string().describe("Worktree path"),
        repoName: z.string().optional(),
        includeDetails: z.boolean().optional().describe("Include file-level details"),
      },
    },
    wrapHandler((params, extra) => handleGetWorktreeStatus(context, params, extra)),
  );

  server.registerTool(
    "create_worktree",
    {
      description:
        "Create a worktree for a branch. If branch does not exist, creates it from baseBranch. Optionally pushes to remote.",
      inputSchema: {
        branchName: z.string().describe("Branch to create worktree for"),
        baseBranch: z.string().optional().describe("Base branch (required if creating new branch)"),
        push: z.boolean().optional().describe("Push new branch to remote"),
        repoName: z.string().optional(),
      },
    },
    wrapHandler((params, extra) => handleCreateWorktree(context, params, extra)),
  );

  server.registerTool(
    "remove_worktree",
    {
      description:
        "Remove a worktree after safety checks (clean, no unpushed commits, no stash, no operation in progress).",
      inputSchema: {
        path: z.string().describe("Worktree path to remove"),
        force: z.boolean().optional().describe("Skip safety checks"),
        repoName: z.string().optional(),
      },
    },
    wrapHandler((params, extra) => handleRemoveWorktree(context, params, extra)),
  );

  server.registerTool(
    "sync",
    {
      description:
        "Full synchronization: fetch, create new worktrees for remote branches, prune removed, update existing. Requires config. Emits progress notifications.",
      inputSchema: {
        repoName: z.string().optional(),
      },
    },
    wrapHandler((params, extra) => handleSync(context, params, extra)),
  );

  server.registerTool(
    "update_worktree",
    {
      description: "Fast-forward a single worktree to match upstream.",
      inputSchema: {
        path: z.string().describe("Worktree path"),
        repoName: z.string().optional(),
      },
    },
    wrapHandler((params, extra) => handleUpdateWorktree(context, params, extra)),
  );

  server.registerTool(
    "initialize",
    {
      description:
        "Initialize a repository (clone bare repo, create main worktree). Requires config. Emits progress notifications.",
      inputSchema: {
        repoName: z.string().optional(),
      },
    },
    wrapHandler((params, extra) => handleInitialize(context, params, extra)),
  );

  server.registerTool(
    "load_config",
    {
      description: "Load or reload a sync-worktrees config file. Response includes repository list.",
      inputSchema: {
        configPath: z.string().optional().describe("Path to config file (defaults to SYNC_WORKTREES_CONFIG env)"),
      },
    },
    wrapHandler((params, extra) => handleLoadConfig(context, params, extra)),
  );

  server.registerTool(
    "set_current_repository",
    {
      description: "Set the current repository for subsequent tool calls that omit repoName.",
      inputSchema: {
        repoName: z.string().describe("Repository name to set as current"),
      },
    },
    wrapHandler((params, extra) => handleSetCurrentRepository(context, params, extra)),
  );

  return server;
}
