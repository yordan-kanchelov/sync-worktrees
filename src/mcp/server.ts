import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { buildUnsupportedContext } from "./context";
import {
  handleCreateWorktree,
  handleDetectContext,
  handleGetWorktreeStatus,
  handleInitialize,
  handleListWorktrees,
  handleLoadConfig,
  handleSetCurrentRepository,
  handleSync,
  handleUpdateWorktree,
} from "./handlers";
import { wrapHandler } from "./utils";

import type { DiscoveredRepoContext, RepositoryContext } from "./context";

const REPO_NAME_DESCRIBE =
  "Repo name from loaded config. Omit to use current (set via set_current_repository) or the only loaded repo.";

const PATH_DESCRIBE_SUFFIX = "Absolute preferred; relative resolves from server CWD.";

const SERVER_INSTRUCTIONS =
  "Call `detect_context` for the project map and live worktree state; `configuredRepositories` in its response is the server-wide loaded-config inventory. Use `set_current_repository` to switch repos. Auto-loads sync-worktrees.config.{js,mjs,cjs,ts} via walk-up. Repos run in one of two modes. worktree (default): a bare repo plus branch worktrees, with new worktrees created under worktreeDir. clone: one standalone checkout where worktreeDir is the repo root. create_worktree and update_worktree are worktree-mode only; in clone mode, use sync to update the checkout.";

export interface ServerSnapshot {
  discovered: DiscoveredRepoContext | null;
  configuredRepoCount?: number;
}

export function buildInstructions(snapshot?: ServerSnapshot): string {
  const d = snapshot?.discovered;

  if (!d || !d.isWorktree || d.kind !== "managed") {
    return SERVER_INSTRUCTIONS;
  }

  const fields: string[] = [];
  if (d.repoName) fields.push(`workspace=${d.repoName}`);
  if (d.currentWorktreePath) fields.push(`path=${d.currentWorktreePath}`);
  if (d.configPath) fields.push(`config=${d.configPath}`);
  if (typeof snapshot?.configuredRepoCount === "number") {
    fields.push(`configuredRepos=${snapshot.configuredRepoCount}`);
  }
  fields.push(`worktrees=${d.allWorktrees.length}`);

  return `${SERVER_INSTRUCTIONS} Connect-time: ${fields.join(" ")}.`;
}

export function createServer(context: RepositoryContext, snapshot?: ServerSnapshot): McpServer {
  const server = new McpServer(
    {
      name: "sync-worktrees",
      version: "1.0.0",
    },
    {
      instructions: buildInstructions(snapshot),
    },
  );

  server.registerResource(
    "workspace",
    "sync-worktrees://workspace",
    {
      title: "Workspace context",
      description:
        "Workspace context: isWorktree, kind, currentWorktreePath, currentBranch, allWorktrees, siblingRepositories, configPath, capabilities {available,reason}, configuredRepositories (server-wide loaded-config inventory). {isWorktree:false} when outside any workspace.",
      mimeType: "application/json",
    },
    async (uri) => {
      let payload: unknown;
      try {
        const discovered = await context.detectFromPath(process.cwd());
        const configuredRepositories = await context.getConfiguredRepositorySummaries();
        payload = { ...discovered, configuredRepositories };
      } catch (err) {
        payload = buildUnsupportedContext(process.cwd(), err instanceof Error ? err.message : String(err));
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(payload),
          },
        ],
      };
    },
  );

  server.registerTool(
    "detect_context",
    {
      description:
        "Detect sync-worktrees structure from path (default: CWD). Reads .git, resolves bare repo, walks up to auto-load sync-worktrees.config.{js,mjs,cjs,ts}. Returns: configuredRepositories (server-wide loaded-config inventory; independent of params.path), bareRepoPath, allWorktrees, siblingRepositories, currentWorktreePath, configPath, capabilities {available,reason}, notes. Lean configuredRepositories entries are mode-discriminated: clone → {name, mode:'clone', checkoutPath, isCurrent}; worktree → {name, mode:'worktree', worktreeDir, isCurrent}. detailed=true adds repoUrl, branch?, sparseCheckout?, localReady, plus bareRepoDir for worktree mode. Use at session start or to bootstrap from unknown checkout.",
      inputSchema: {
        path: z.string().optional().describe("Directory to inspect. Default: server CWD."),
        detailed: z
          .boolean()
          .optional()
          .default(false)
          .describe("Expand configuredRepositories with repoUrl, branch, sparseCheckout, localReady, bareRepoDir."),
        includeAllWorktrees: z
          .boolean()
          .optional()
          .describe("Include allWorktreesByRepo + allWorktreeErrorsByRepo for each configured repo. Default: false."),
        includeStatus: z
          .boolean()
          .optional()
          .describe(
            "Enrich entries with label, divergence, staleHint. Adds 1 git status + rev-list per worktree. Labels here are metadata-blind (no sync metadata is loaded), so a fully-pushed branch whose remote was deleted shows 'dirty'; list_worktrees gives the authoritative label/safeToRemove. Default: false.",
          ),
      },
      annotations: {
        title: "Detect sync-worktrees context",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    wrapHandler((params, extra) => handleDetectContext(context, params, extra)),
  );

  server.registerTool(
    "list_worktrees",
    {
      description:
        "List worktrees with status. No repoName + config loaded = all configured repos grouped by repoName. With repoName = single repo. Entries: {path, branch, isCurrent, label (clean|dirty|stale|current|unknown), status, divergence, safeToRemove, lastSyncAt, sizeBytes}.",
      inputSchema: {
        repoName: z.string().optional().describe("Repo name. Omit + config loaded = list all configured repos."),
        includeSize: z
          .boolean()
          .optional()
          .describe(
            "Compute on-disk size per worktree (bytes). Slow on large worktrees. Default: false (sizeBytes=null).",
          ),
      },
      annotations: {
        title: "List worktrees with status",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    wrapHandler((params, extra) => handleListWorktrees(context, params, extra)),
  );

  server.registerTool(
    "get_worktree_status",
    {
      description:
        "Detailed status for one worktree: dirty files, unpushed commits, stashes, upstream gone, ops in progress. Returns: status + divergence {ahead,behind} + resolved path.",
      inputSchema: {
        path: z.string().describe(`Worktree path. ${PATH_DESCRIBE_SUFFIX}`),
        repoName: z.string().optional().describe(REPO_NAME_DESCRIBE),
        includeDetails: z
          .boolean()
          .optional()
          .describe("Include file-level lists (modified, untracked, staged). Default: false (counts only)."),
      },
      annotations: {
        title: "Get worktree status",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    wrapHandler((params, extra) => handleGetWorktreeStatus(context, params, extra)),
  );

  server.registerTool(
    "create_worktree",
    {
      description:
        "Worktree-mode only; clone-mode repos error here. Create worktree for a branch. Existing branch (local/remote) = checkout. New branch = create from baseBranch + push to origin (default). baseBranch required only for new branches — pass defensively if unsure. push=false opts out. Preconditions: repo initialized (auto-runs). Returns: {success, branchName, worktreePath, created, pushed}.",
      inputSchema: {
        branchName: z.string().describe("Branch name. Slashes/special chars sanitized for dir name."),
        baseBranch: z
          .string()
          .optional()
          .describe(
            "Base for new branch. Required if branchName doesn't exist locally or remotely; ignored otherwise.",
          ),
        push: z.boolean().optional().describe("Push new branch to origin. Default: true. Ignored if branch existed."),
        repoName: z.string().optional().describe(REPO_NAME_DESCRIBE),
      },
      annotations: {
        title: "Create worktree",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    wrapHandler((params, extra) => handleCreateWorktree(context, params, extra)),
  );

  server.registerTool(
    "sync",
    {
      description:
        "Repo-wide sync: fetch, create worktrees for new remote branches, remove pruned (clean only), fast-forward existing. Emits progress. In worktree mode: single worktree? Use update_worktree. Single create? Use create_worktree. Preconditions: config loaded + repo initialized (auto-runs). Returns: {success, duration, skips}.",
      inputSchema: {
        repoName: z.string().optional().describe(REPO_NAME_DESCRIBE),
      },
      annotations: {
        title: "Sync repository worktrees",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    wrapHandler((params, extra) => handleSync(context, params, extra)),
  );

  server.registerTool(
    "update_worktree",
    {
      description:
        "Worktree-mode only; clone-mode repos error here; use sync to update the checkout. Fast-forward one worktree to upstream. No merge, no rebase, aborts if not fast-forwardable. Whole repo? Use sync.",
      inputSchema: {
        path: z.string().describe(`Worktree path to fast-forward. ${PATH_DESCRIBE_SUFFIX}`),
        repoName: z.string().optional().describe(REPO_NAME_DESCRIBE),
      },
      annotations: {
        title: "Fast-forward one worktree",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    wrapHandler((params, extra) => handleUpdateWorktree(context, params, extra)),
  );

  server.registerTool(
    "initialize",
    {
      description:
        "Initialize repo: clone as bare if missing, create main worktree. Idempotent. Emits progress. Preconditions: config loaded. Returns: {success, defaultBranch, worktreeDir}.",
      inputSchema: {
        repoName: z.string().optional().describe(REPO_NAME_DESCRIBE),
      },
      annotations: {
        title: "Initialize repository",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    wrapHandler((params, extra) => handleInitialize(context, params, extra)),
  );

  server.registerTool(
    "load_config",
    {
      description:
        "Load/reload sync-worktrees JS config into session. Replaces previously loaded repos. Uses configPath, SYNC_WORKTREES_CONFIG, an already detected config, or a launch-CWD auto-detect fallback. For first discovery from an arbitrary project path, call detect_context with path. Returns: {configPath, currentRepository, repositories: [{name, repoUrl, worktreeDir, source}]}.",
      inputSchema: {
        configPath: z
          .string()
          .optional()
          .describe(
            "Config file path. Falls back to SYNC_WORKTREES_CONFIG, an already detected config, or launch-CWD auto-detect.",
          ),
      },
      annotations: {
        title: "Load sync-worktrees config",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    wrapHandler((params, extra) => handleLoadConfig(context, params, extra)),
  );

  server.registerTool(
    "set_current_repository",
    {
      description:
        "Set current repo for tool calls that omit repoName. Session-scoped. Preconditions: load_config called.",
      inputSchema: {
        repoName: z.string().describe("Repo name from loaded config repositories[].name."),
      },
      annotations: {
        title: "Set current repository",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    wrapHandler((params, extra) => handleSetCurrentRepository(context, params, extra)),
  );

  return server;
}
