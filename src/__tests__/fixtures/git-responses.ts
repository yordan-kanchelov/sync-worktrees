/**
 * Common git response fixtures for testing
 */

export const gitBranchResponses = {
  withMultipleBranches: {
    all: ["origin/main", "origin/feature-1", "origin/feature-2", "origin/bugfix/issue-123", "origin/release/v1.0.0"],
    current: "main",
    branches: {},
    detached: false,
  },
  withSingleBranch: {
    all: ["origin/main"],
    current: "main",
    branches: {},
    detached: false,
  },
  empty: {
    all: [],
    current: "",
    branches: {},
    detached: false,
  },
  withLocalAndRemote: {
    all: ["main", "feature-local", "origin/main", "origin/feature-1", "origin/feature-2"],
    current: "main",
    branches: {},
    detached: false,
  },
};

export const gitStatusResponses = {
  clean: {
    isClean: () => true,
    not_added: [],
    conflicted: [],
    created: [],
    deleted: [],
    modified: [],
    renamed: [],
    files: [],
    staged: [],
    ahead: 0,
    behind: 0,
    current: "main",
    tracking: "origin/main",
    detached: false,
  },
  withChanges: {
    isClean: () => false,
    not_added: ["new-file.txt"],
    conflicted: [],
    created: [],
    deleted: [],
    modified: ["existing-file.ts"],
    renamed: [],
    files: [
      { path: "new-file.txt", index: "?", working_dir: "?" },
      { path: "existing-file.ts", index: " ", working_dir: "M" },
    ],
    staged: [],
    ahead: 0,
    behind: 0,
    current: "feature-1",
    tracking: "origin/feature-1",
    detached: false,
  },
  withStagedChanges: {
    isClean: () => false,
    not_added: [],
    conflicted: [],
    created: ["new-file.txt"],
    deleted: [],
    modified: ["existing-file.ts"],
    renamed: [],
    files: [
      { path: "new-file.txt", index: "A", working_dir: " " },
      { path: "existing-file.ts", index: "M", working_dir: " " },
    ],
    staged: ["new-file.txt", "existing-file.ts"],
    ahead: 1,
    behind: 0,
    current: "feature-1",
    tracking: "origin/feature-1",
    detached: false,
  },
};

export const worktreeScenarios = {
  // Scenario: Fresh repository with no worktrees
  fresh: {
    remoteBranches: ["main", "develop", "feature-1"],
    existingWorktrees: [],
    expectedNewWorktrees: ["main", "develop", "feature-1"],
    expectedRemovals: [],
  },
  // Scenario: Some worktrees already exist
  partial: {
    remoteBranches: ["main", "develop", "feature-1", "feature-2"],
    existingWorktrees: ["main", "develop"],
    expectedNewWorktrees: ["feature-1", "feature-2"],
    expectedRemovals: [],
  },
  // Scenario: Need to prune old worktrees
  withStale: {
    remoteBranches: ["main", "develop"],
    existingWorktrees: ["main", "develop", "old-feature", "deleted-branch"],
    expectedNewWorktrees: [],
    expectedRemovals: ["old-feature", "deleted-branch"],
  },
  // Scenario: Mixed - add new and remove old
  mixed: {
    remoteBranches: ["main", "develop", "new-feature"],
    existingWorktrees: ["main", "old-feature"],
    expectedNewWorktrees: ["develop", "new-feature"],
    expectedRemovals: ["old-feature"],
  },
};
