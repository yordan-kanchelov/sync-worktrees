import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { buildUnsupportedContext } from "./context";
import {
  handleCompareBranch,
  handleCreateWorktree,
  handleDetectContext,
  handleGetWorktreeStatus,
  handleInitialize,
  handleListBranches,
  handleListWorktrees,
  handleLoadConfig,
  handleRemoveWorktree,
  handleSetCurrentRepository,
  handleSync,
  handleUpdateWorktree,
} from "./handlers";
import { wrapHandler } from "./utils";

import type { RepositoryContext } from "./context";

const REPO_NAME_DESCRIBE =
  "Repository name from loaded config. If omitted, uses the current repository set via set_current_repository or the only loaded repo.";

const PATH_DESCRIBE_SUFFIX = "Absolute path preferred; relative paths resolve from the server's CWD.";

const SERVER_INSTRUCTIONS =
  "Before running git worktree operations, call `detect_context` to learn the current repo, current branch, and which capabilities are available. " +
  "It reports whether the working directory is inside a sync-worktrees-managed workspace, lists sibling worktrees, and explains why any capability is disabled.";

export function createServer(context: RepositoryContext): McpServer {
  const server = new McpServer(
    {
      name: "sync-worktrees",
      version: "1.0.0",
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.registerResource(
    "workspace",
    "sync-worktrees://workspace",
    {
      title: "Workspace context",
      description:
        "Current sync-worktrees workspace context: whether CWD is inside a managed worktree, the current branch, sibling worktrees, and available capabilities. Returns { isWorktree: false } when CWD is outside any workspace.",
      mimeType: "application/json",
    },
    async (uri) => {
      let discovered: unknown;
      try {
        discovered = await context.detectFromPath(process.cwd());
      } catch (err) {
        discovered = buildUnsupportedContext(process.cwd(), err instanceof Error ? err.message : String(err));
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(discovered, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "detect_context",
    {
      description:
        "Detect sync-worktrees structure from a filesystem path. Reads .git file, resolves bare repo, discovers sibling worktrees. Defaults to CWD. " +
        "Use when: bootstrapping from an unknown checkout with no config loaded. " +
        "Returns: discovered repo root, bare repo path, all sibling worktrees, current worktree path, capabilities.",
      inputSchema: {
        path: z.string().optional().describe("Directory path to inspect. Defaults to the server's CWD."),
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
        "List all worktrees of a repository with enriched status. " +
        "Returns: array of { path, branch, isCurrent, label (clean|dirty|stale|current|unknown), status, divergence (ahead/behind), safeToRemove, lastSyncAt }. " +
        "When includePendingDetails=true, each entry also includes pendingWork: { dirtyFiles, untrackedCount, unpushedCommits, stashes } — useful for cross-worktree 'what's unfinished' queries without N round-trips to get_worktree_status.",
      inputSchema: {
        repoName: z.string().optional().describe(REPO_NAME_DESCRIBE),
        includePendingDetails: z
          .boolean()
          .optional()
          .describe(
            "If true, enrich each entry with pendingWork (dirtyFiles, untrackedCount, unpushedCommits, stashes). " +
              "unpushedCommits and stashes are numbers when known; null means the underlying git query failed transiently though the boolean flag in status is still set. Default: false.",
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
    "list_branches",
    {
      description:
        "List remote and local branches enriched with sync-worktrees context. For each remote branch includes lastActivity (ISO8601), hasWorktree, and matchesConfigFilter (branchInclude/branchExclude from loaded config). " +
        "Returns: { remote: [...], local: [...], branchesWithoutWorktrees: string[] (remote branches passing config filters but without a worktree), branchesFilteredByConfig: string[] (remote branches excluded by config), configFiltersApplied: boolean }. " +
        "Use to answer 'which branches need a worktree' or 'which branches would sync act on'.",
      inputSchema: {
        scope: z
          .enum(["remote", "local", "both"])
          .optional()
          .describe("Which branch sets to include. Default: 'both'."),
        applyConfigFilters: z
          .boolean()
          .optional()
          .describe(
            "If true (default), compute branchesWithoutWorktrees from branches passing branchInclude/branchExclude. If false, consider all remote branches.",
          ),
        repoName: z.string().optional().describe(REPO_NAME_DESCRIBE),
      },
      annotations: {
        title: "List branches with worktree/config status",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    wrapHandler((params, extra) => handleListBranches(context, params, extra)),
  );

  server.registerTool(
    "get_worktree_status",
    {
      description:
        "Get detailed status for one worktree (dirty files, unpushed commits, stashes, upstream gone, operations in progress). " +
        "Returns: full status object plus divergence { ahead, behind } and resolved absolute path.",
      inputSchema: {
        path: z.string().describe(`Worktree path. ${PATH_DESCRIBE_SUFFIX}`),
        repoName: z.string().optional().describe(REPO_NAME_DESCRIBE),
        includeDetails: z
          .boolean()
          .optional()
          .describe("If true, includes file-level lists (modified, untracked, staged). Default: false (counts only)."),
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
    "compare_branch",
    {
      description:
        "Inspect a branch or worktree and return a structured action verdict (not raw stats). Use BEFORE remove/update to avoid destructive surprises. " +
        "Two modes (provide exactly one): {path} inspects a worktree (full safety check incl. dirty/unpushed/stash/upstream-gone). {branchName} inspects a branch in the bare repo without requiring a worktree. " +
        "Verdicts: safe-to-remove | would-lose-work | can-fast-forward | up-to-date | local-ahead | diverged-needs-review | no-upstream | no-local-branch. " +
        "Returns: { verdict, reasons[], mode, branch, hasWorktree, hasLocalBranch, ahead, behind, localCommit, remoteCommit, ... }.",
      inputSchema: {
        path: z.string().optional().describe(`Worktree path (path mode). ${PATH_DESCRIBE_SUFFIX}`),
        branchName: z
          .string()
          .optional()
          .describe("Branch name (branchName mode). Compared against origin/<branchName> in the bare repo."),
        repoName: z.string().optional().describe(REPO_NAME_DESCRIBE),
      },
      annotations: {
        title: "Compare branch state and produce action verdict",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    wrapHandler((params, extra) => handleCompareBranch(context, params, extra)),
  );

  server.registerTool(
    "create_worktree",
    {
      description:
        "Create a worktree for a branch. If the branch exists (local or remote), checks it out; otherwise creates it from baseBranch. Optionally pushes the new branch to origin. " +
        "Key params: baseBranch is required only when the branch does not yet exist — pass it defensively if unsure. push=true only affects newly created branches. " +
        "Preconditions: repository must be initialized (auto-runs on first call). " +
        "Returns: { success, branchName, worktreePath, created, pushed }.",
      inputSchema: {
        branchName: z
          .string()
          .describe("Branch name. Slashes and special chars are sanitized for the worktree directory name."),
        baseBranch: z
          .string()
          .optional()
          .describe(
            "Base branch for creating a new branch. Required if branchName does not exist locally or remotely; ignored otherwise.",
          ),
        push: z
          .boolean()
          .optional()
          .describe("Push the newly created branch to origin. Ignored if the branch already existed."),
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
    "remove_worktree",
    {
      description:
        "Remove a worktree. Runs safety checks first: rejects if worktree is dirty, has unpushed commits, has stashes, has an in-progress git operation (merge/rebase/cherry-pick/revert/bisect), or is locked via `git worktree lock`. " +
        "force=true: runs `git worktree remove --force --force`, which DELETES uncommitted and untracked files in the worktree directory AND removes it even if locked via `git worktree lock`. Branch ref, stashes, and remote state are preserved. " +
        "Returns: { success, removedPath }.",
      inputSchema: {
        path: z.string().describe(`Worktree path to remove. ${PATH_DESCRIBE_SUFFIX}`),
        force: z
          .boolean()
          .optional()
          .describe(
            "Skip safety checks and delete uncommitted/untracked files in the worktree directory. Branch ref is preserved. Default: false.",
          ),
        repoName: z.string().optional().describe(REPO_NAME_DESCRIBE),
      },
      annotations: {
        title: "Remove worktree",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    wrapHandler((params, extra) => handleRemoveWorktree(context, params, extra)),
  );

  server.registerTool(
    "sync",
    {
      description:
        "Full repo-wide synchronization: fetch all, create worktrees for new remote branches, remove worktrees for pruned remote branches (clean only), fast-forward existing worktrees. Emits progress notifications. " +
        "Do not use when: you only need to update one worktree — use update_worktree. Only need to create one — use create_worktree. " +
        "Preconditions: config must be loaded (load_config) and the repository initialized (auto-runs on first call). " +
        "Returns: { success, duration } after sync completes.",
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
        "Fast-forward one worktree to match its upstream. No merge commits, no rebasing, aborts if not fast-forwardable. Rejects if the worktree is locked via `git worktree lock`. " +
        "Do not use when: you want to update every worktree in the repo — use sync.",
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
        "Initialize a repository: clone as bare repo if missing, create main worktree. Safe to call on already-initialized repos (no-op-ish). Emits progress notifications. " +
        "Preconditions: config must be loaded (load_config) so the repo's URL and paths are known. " +
        "Returns: { success, defaultBranch, worktreeDir }.",
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
        "Load or reload a sync-worktrees JavaScript config file into the server's session. Replaces any previously loaded repositories. " +
        "Call this before sync/initialize/create_worktree when using a config-driven workflow. " +
        "Returns: { configPath, currentRepository, repositories: [{ name, repoPath, worktreeDir, ... }] }.",
      inputSchema: {
        configPath: z
          .string()
          .optional()
          .describe(
            "Path to the config file. If omitted, falls back to the SYNC_WORKTREES_CONFIG env var. Errors if neither is set.",
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
        "Set the current repository for subsequent tool calls that omit repoName. Session-scoped; not persisted across server restarts. " +
        "Preconditions: load_config must have been called so the name is known.",
      inputSchema: {
        repoName: z.string().describe("Repository name as listed in the loaded config's `repositories[].name`."),
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
