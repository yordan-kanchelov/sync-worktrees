import * as path from "path";

import { PathResolutionService } from "./path-resolution.service";

import type { SparseCheckoutConfig } from "../types";

export interface WorktreeInventory {
  remoteBranches: string[];
  defaultBranch: string;
  existingWorktrees: WorktreeEntry[];
  worktreeDir: string;
}

export interface WorktreeEntry {
  path: string;
  branch: string;
}

export type CreateAction =
  | { kind: "create"; branch: string; path: string }
  | { kind: "skip-create"; branch: string; path: string; reason: "path-collision"; conflictingBranch: string };

export type PruneAction = { kind: "check-prune"; branch: string; path: string };

export type UpdateAction = { kind: "update-candidate"; branch: string; path: string };

export type SparseAction =
  | { kind: "check-sparse"; branch: string; path: string }
  | { kind: "skip-sparse"; branch: string; path: string; reason: "not-configured" };

export type SyncAction = CreateAction | PruneAction | UpdateAction | SparseAction;

export interface SyncPlan {
  create: CreateAction[];
  prune: PruneAction[];
  update: UpdateAction[];
  sparse: SparseAction[];
  warnings: string[];
}

export interface SyncPlanOptions {
  pathResolution?: PathResolutionService;
  updateExistingWorktrees?: boolean;
  sparseCheckout?: SparseCheckoutConfig;
}

export function createWorktreeSyncPlan(inventory: WorktreeInventory, options: SyncPlanOptions = {}): SyncPlan {
  return {
    create: planCreateActions(inventory, options),
    prune: planPruneActions(inventory),
    update: options.updateExistingWorktrees === false ? [] : planUpdateActions(inventory),
    sparse: planSparseActions(inventory, options.sparseCheckout),
    warnings: [],
  };
}

export function planCreateActions(inventory: WorktreeInventory, options: SyncPlanOptions = {}): CreateAction[] {
  const pathResolution = options.pathResolution ?? new PathResolutionService();
  const existingBranches = new Set(inventory.existingWorktrees.map((w) => w.branch));
  const newBranches = inventory.remoteBranches.filter(
    (branch) => !existingBranches.has(branch) && branch !== inventory.defaultBranch,
  );

  const reservedPaths = new Map<string, string>();
  for (const worktree of inventory.existingWorktrees) {
    reservedPaths.set(path.resolve(worktree.path), worktree.branch);
  }

  const actions: CreateAction[] = [];
  for (const branch of newBranches) {
    const worktreePath = pathResolution.getBranchWorktreePath(inventory.worktreeDir, branch);
    const resolved = path.resolve(worktreePath);
    const conflictingBranch = reservedPaths.get(resolved);

    if (conflictingBranch && conflictingBranch !== branch) {
      actions.push({
        kind: "skip-create",
        branch,
        path: worktreePath,
        reason: "path-collision",
        conflictingBranch,
      });
      continue;
    }

    reservedPaths.set(resolved, branch);
    actions.push({ kind: "create", branch, path: worktreePath });
  }

  return actions;
}

export function planPruneActions(inventory: WorktreeInventory): PruneAction[] {
  const remoteBranches = new Set(inventory.remoteBranches);
  return inventory.existingWorktrees
    .filter((worktree) => !remoteBranches.has(worktree.branch))
    .map((worktree) => ({ kind: "check-prune", branch: worktree.branch, path: worktree.path }));
}

export function planUpdateActions(inventory: WorktreeInventory): UpdateAction[] {
  const remoteBranches = new Set(inventory.remoteBranches);
  return inventory.existingWorktrees
    .filter((worktree) => remoteBranches.has(worktree.branch))
    .map((worktree) => ({ kind: "update-candidate", branch: worktree.branch, path: worktree.path }));
}

export function planSparseActions(inventory: WorktreeInventory, sparseCheckout?: SparseCheckoutConfig): SparseAction[] {
  if (!sparseCheckout) {
    return [];
  }

  return inventory.existingWorktrees.map((worktree) => ({
    kind: "check-sparse",
    branch: worktree.branch,
    path: worktree.path,
  }));
}
