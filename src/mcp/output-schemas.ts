import { z } from "zod";

/**
 * Output schemas advertised on `tools/list` and enforced on `tools/call`
 * (SEP-2106, protocol revision 2026-07-28).
 *
 * The SDK validates every result whose tool advertises a schema: a missing or
 * mismatched `structuredContent` is turned into an `isError` result. Two rules
 * keep that safe as the handlers evolve:
 *
 * 1. A field is `required` here only when the handler's TypeScript return type
 *    guarantees it. Anything optional or conditional is `.optional()`.
 * 2. Every object is loose, so adding a field to a response is never a
 *    breaking wire change.
 *
 * Error results (`isError: true`) carry no `structuredContent` and are exempt
 * from validation, so `formatErrorResponse` stays schema-free.
 */

const worktreeLabelSchema = z.enum(["current", "dirty", "stale", "clean", "unknown"]);

const divergenceSchema = z
  .looseObject({
    ahead: z.number().describe("Commits on this branch not on its upstream."),
    behind: z.number().describe("Commits on the upstream not on this branch."),
  })
  .nullable()
  .describe("null when the worktree has no upstream or rev-list failed.");

const capabilityStateSchema = z.looseObject({
  available: z.boolean(),
  reason: z.string().optional().describe("Why the capability is unavailable. Absent when available."),
});

const capabilitiesSchema = z.looseObject({
  listWorktrees: capabilityStateSchema,
  getStatus: capabilityStateSchema,
  createWorktree: capabilityStateSchema,
  updateWorktree: capabilityStateSchema,
  sync: capabilityStateSchema,
  initialize: capabilityStateSchema,
});

const discoveredWorktreeSchema = z.looseObject({
  path: z.string(),
  branch: z.string(),
  isCurrent: z.boolean(),
  label: worktreeLabelSchema.optional().describe("Only present when includeStatus=true."),
  divergence: divergenceSchema.optional(),
  staleHint: z.boolean().optional().describe("Upstream ref is gone. Only present when includeStatus=true."),
});

const siblingRepositorySchema = z.looseObject({
  name: z.string(),
  bareRepoPath: z.string(),
  worktreeDir: z.string().nullable(),
  repoUrl: z.string().nullable(),
  sparseCheckout: z.unknown().optional(),
  present: z.boolean(),
  configMatched: z.boolean(),
});

const configuredRepositorySummarySchema = z.looseObject({
  name: z.string(),
  isCurrent: z.boolean(),
  mode: z.enum(["clone", "worktree"]),
  checkoutPath: z.string().optional().describe("clone mode only."),
  worktreeDir: z.string().optional().describe("worktree mode only."),
  bareRepoDir: z.string().optional().describe("worktree mode, detailed=true only."),
  repoUrl: z.string().optional().describe("detailed=true only."),
  branch: z.string().optional().describe("detailed=true only."),
  sparseCheckout: z.unknown().optional().describe("detailed=true only."),
  localReady: z.boolean().optional().describe("detailed=true only."),
});

/** Shared between the `status` member of a listed worktree and the flattened `get_worktree_status` result. */
const worktreeStatusShape = {
  isClean: z.boolean(),
  hasUnpushedCommits: z.boolean(),
  hasStashedChanges: z.boolean(),
  hasOperationInProgress: z.boolean(),
  hasModifiedSubmodules: z.boolean(),
  upstreamGone: z.boolean(),
  fullyPushedUpstreamDeleted: z
    .boolean()
    .describe("Commits look unpushed only because the upstream ref was deleted after they landed."),
  canRemove: z.boolean(),
  reasons: z.array(z.string()),
  details: z
    .looseObject({})
    .optional()
    .describe("File-level lists (modified, untracked, staged). Only present when includeDetails=true."),
};

const worktreeStatusSchema = z.looseObject(worktreeStatusShape);

const safeToRemoveSchema = z.looseObject({
  safe: z.boolean(),
  reason: z.string(),
});

const listedWorktreeSchema = z.looseObject({
  path: z.string(),
  branch: z.string(),
  isCurrent: z.boolean(),
  label: worktreeLabelSchema,
  status: worktreeStatusSchema.nullable().describe("null when the status probe failed."),
  divergence: divergenceSchema,
  safeToRemove: safeToRemoveSchema,
  lastSyncAt: z.string().nullable(),
  sizeBytes: z.number().nullable().describe("null unless includeSize=true."),
});

const repositoryListEntrySchema = z.looseObject({
  name: z.string(),
  repoUrl: z.string(),
  worktreeDir: z.string(),
  source: z.enum(["config", "detected"]),
});

export const detectContextOutputSchema = z.looseObject({
  isWorktree: z.boolean(),
  kind: z.enum(["managed", "unmanaged", "unsupported"]),
  currentBranch: z.string().nullable(),
  currentWorktreePath: z.string().nullable(),
  bareRepoPath: z.string().nullable(),
  repoUrl: z.string().nullable(),
  worktreeDir: z.string().nullable(),
  allWorktrees: z.array(discoveredWorktreeSchema),
  allWorktreesByRepo: z
    .record(z.string(), z.array(discoveredWorktreeSchema))
    .optional()
    .describe("Only present when includeAllWorktrees=true."),
  allWorktreeErrorsByRepo: z
    .record(z.string(), z.string())
    .optional()
    .describe("Per-repo enumeration errors. Only present when includeAllWorktrees=true and something failed."),
  siblingRepositories: z.array(siblingRepositorySchema),
  configPath: z.string().nullable(),
  repoName: z.string().nullable(),
  capabilities: capabilitiesSchema,
  notes: z.array(z.string()),
  configuredRepositories: z
    .array(configuredRepositorySummarySchema)
    .describe("Server-wide loaded-config inventory, independent of params.path."),
});

export const listWorktreesOutputSchema = z.looseObject({
  worktrees: z
    .array(listedWorktreeSchema)
    .optional()
    .describe("Present for a single repo (repoName given, or no config)."),
  repositories: z
    .record(
      z.string(),
      z.looseObject({
        worktrees: z.array(listedWorktreeSchema),
        error: z.string().optional().describe("Present instead of results when this repo failed to enumerate."),
      }),
    )
    .optional()
    .describe("Present when listing all configured repos (no repoName)."),
});

export const getWorktreeStatusOutputSchema = z.looseObject({
  path: z.string().describe("Resolved absolute worktree path."),
  ...worktreeStatusShape,
  divergence: divergenceSchema,
});

export const createWorktreeOutputSchema = z.looseObject({
  success: z.boolean().describe("false when the worktree was created but pushing the new branch failed."),
  branchName: z.string(),
  worktreePath: z.string(),
  created: z.boolean().describe("The branch was newly created (vs. an existing local/remote branch checked out)."),
  pushed: z.boolean(),
  pushError: z.string().optional().describe("Present only when success=false."),
});

const syncOutcomeScopeSchema = z.enum(["repo", "branch", "worktree", "sparse-checkout"]);

const syncOutcomeActionSchema = z.looseObject({
  kind: z.enum(["created", "removed", "updated", "noop", "skipped", "preserved-diverged", "failed"]),
  branch: z.string().optional(),
  path: z.string().optional(),
  scope: syncOutcomeScopeSchema.optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
  warning: z.string().optional(),
  error: z.string().optional(),
  preservedPath: z.string().optional(),
});

const syncFailedActionSchema = z.looseObject({
  kind: z.literal("failed"),
  scope: syncOutcomeScopeSchema,
  error: z.string(),
  reason: z.string().optional().describe("Machine-readable cause, e.g. remove_failed, sync_failed."),
  branch: z.string().optional(),
  path: z.string().optional(),
});

export const syncOutputSchema = z.looseObject({
  success: z
    .boolean()
    .describe(
      "false when any action failed (failed > 0), matching the CLI's non-zero exit. The call itself still completed, so isError stays false.",
    ),
  duration: z.number().describe("Wall-clock milliseconds."),
  failed: z.number().describe("Number of failed actions; equals outcome.counts.failed."),
  failures: z
    .array(syncFailedActionSchema)
    .describe("The failed entries of outcome.actions, so callers need not filter them out."),
  outcome: z.looseObject({
    repoName: z.string().optional(),
    mode: z.enum(["clone", "worktree"]),
    started: z.literal(true),
    counts: z.looseObject({
      created: z.number(),
      removed: z.number(),
      updated: z.number(),
      skipped: z.number(),
      preserved: z.number(),
      failed: z.number(),
      noop: z.number(),
    }),
    actions: z.array(syncOutcomeActionSchema),
    durationMs: z.number().optional(),
  }),
  skips: z.array(
    z.looseObject({
      kind: z.string(),
      message: z.string().describe("Human-readable rendering of the skip reason."),
    }),
  ),
});

export const updateWorktreeOutputSchema = z.looseObject({
  success: z.boolean(),
  worktreePath: z.string(),
});

export const initializeOutputSchema = z.looseObject({
  success: z.boolean(),
  defaultBranch: z.string(),
  worktreeDir: z.string(),
});

export const loadConfigOutputSchema = z.looseObject({
  configPath: z.string().describe("Resolved absolute path of the config that was loaded."),
  currentRepository: z.string().nullable(),
  repositories: z.array(repositoryListEntrySchema),
});

export const setCurrentRepositoryOutputSchema = z.looseObject({
  currentRepository: z.string().nullable(),
  repositories: z.array(repositoryListEntrySchema),
});
