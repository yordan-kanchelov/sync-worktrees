import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect, vi, beforeEach } from "vitest";

import WorktreeStatusView, { WorktreeStatusViewProps } from "../WorktreeStatusView";
import type { WorktreeStatusResult } from "../../services/worktree-status.service";
import type { WorktreeStatusEntry, DivergedDirectoryInfo } from "../../types";

const waitForStateUpdate = () => new Promise((resolve) => setTimeout(resolve, 100));

const makeStatus = (overrides: Partial<WorktreeStatusResult> = {}): WorktreeStatusResult => ({
  isClean: true,
  hasUnpushedCommits: false,
  hasStashedChanges: false,
  hasOperationInProgress: false,
  hasModifiedSubmodules: false,
  upstreamGone: false,
  canRemove: true,
  reasons: [],
  ...overrides,
});

const makeEntry = (branch: string, statusOverrides: Partial<WorktreeStatusResult> = {}): WorktreeStatusEntry => ({
  branch,
  path: `/worktrees/${branch}`,
  status: makeStatus(statusOverrides),
});

describe("WorktreeStatusView", () => {
  let defaultProps: WorktreeStatusViewProps;

  const defaultEntries: WorktreeStatusEntry[] = [
    makeEntry("main"),
    makeEntry("feature/auth", {
      isClean: false,
      hasUnpushedCommits: true,
      canRemove: false,
      reasons: ["uncommitted changes", "unpushed commits"],
      details: {
        modifiedFiles: 2,
        deletedFiles: 0,
        renamedFiles: 0,
        createdFiles: 0,
        conflictedFiles: 0,
        untrackedFiles: 0,
        unpushedCommitCount: 3,
      },
    }),
    makeEntry("feature/login", {
      hasStashedChanges: true,
      canRemove: false,
      reasons: ["stashed changes"],
      details: {
        modifiedFiles: 0,
        deletedFiles: 0,
        renamedFiles: 0,
        createdFiles: 0,
        conflictedFiles: 0,
        untrackedFiles: 0,
        stashCount: 1,
      },
    }),
    makeEntry("hotfix/bug-123", {
      hasOperationInProgress: true,
      canRemove: false,
      reasons: ["operation in progress"],
      details: {
        modifiedFiles: 0,
        deletedFiles: 0,
        renamedFiles: 0,
        createdFiles: 0,
        conflictedFiles: 0,
        untrackedFiles: 0,
        operationType: "rebase",
      },
    }),
  ];

  beforeEach(() => {
    defaultProps = {
      repositories: [
        { index: 0, name: "repo-1", repoUrl: "https://example.com/repo-1.git" },
        { index: 1, name: "repo-2", repoUrl: "https://example.com/repo-2.git" },
      ],
      getWorktreeStatusForRepo: vi.fn().mockResolvedValue(defaultEntries),
      onClose: vi.fn(),
    };
  });

  describe("rendering", () => {
    it("should render view title", () => {
      const { lastFrame } = render(<WorktreeStatusView {...defaultProps} />);
      expect(lastFrame()).toContain("Worktree Status");
    });

    it("should show project selection when multiple repositories", () => {
      const { lastFrame } = render(<WorktreeStatusView {...defaultProps} />);
      expect(lastFrame()).toContain("Select repository");
      expect(lastFrame()).toContain("repo-1");
      expect(lastFrame()).toContain("repo-2");
    });

    it("should skip project selection with single repository", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "single-repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("main");
      expect(lastFrame()).not.toContain("Select repository");
    });

    it("should show filter input with match count", () => {
      const { lastFrame } = render(<WorktreeStatusView {...defaultProps} />);
      expect(lastFrame()).toContain("Filter:");
      expect(lastFrame()).toContain("(2/2 matches)");
    });
  });

  describe("project selection", () => {
    it("should highlight selected project", () => {
      const { lastFrame } = render(<WorktreeStatusView {...defaultProps} />);
      expect(lastFrame()).toContain("> repo-1");
    });

    it("should navigate down with arrow key", async () => {
      const { stdin, lastFrame } = render(<WorktreeStatusView {...defaultProps} />);

      stdin.write("\u001B[B");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("> repo-2");
    });

    it("should navigate up with arrow key", async () => {
      const { stdin, lastFrame } = render(<WorktreeStatusView {...defaultProps} />);

      stdin.write("\u001B[B");
      await waitForStateUpdate();
      stdin.write("\u001B[A");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("> repo-1");
    });

    it("should proceed to status view on Enter", async () => {
      const { stdin, lastFrame } = render(<WorktreeStatusView {...defaultProps} />);

      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("main");
      expect(lastFrame()).not.toContain("Select repository");
    });

    it("should close on ESC", async () => {
      const onClose = vi.fn();
      const { stdin } = render(<WorktreeStatusView {...defaultProps} onClose={onClose} />);

      stdin.write("\x1b");
      await waitForStateUpdate();
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("project filtering", () => {
    it("should filter projects when typing", async () => {
      const { stdin, lastFrame } = render(<WorktreeStatusView {...defaultProps} />);

      stdin.write("2");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(1/2 matches)");
      expect(lastFrame()).toContain("repo-2");
    });

    it("should show no matches when filter has no results", async () => {
      const { stdin, lastFrame } = render(<WorktreeStatusView {...defaultProps} />);

      stdin.write("xyz");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(0/2 matches)");
      expect(lastFrame()).toContain("No matches");
    });

    it("should remove filter character on backspace", async () => {
      const { stdin, lastFrame } = render(<WorktreeStatusView {...defaultProps} />);

      stdin.write("xy");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("(0/2 matches)");

      stdin.write("\x7f");
      await waitForStateUpdate();
      stdin.write("\x7f");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(2/2 matches)");
    });
  });

  describe("status view", () => {
    it("should show status indicators for clean worktree", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("✓");
    });

    it("should show M flag for uncommitted changes", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("M");
    });

    it("should show ↑ flag for unpushed commits", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("↑");
    });

    it("should show S flag for stashed changes", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("S");
    });

    it("should show ⚠ flag for operation in progress", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("⚠");
    });

    it("should show ⊞ flag for modified submodules", async () => {
      const entries = [makeEntry("submod-branch", { hasModifiedSubmodules: true })];
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getWorktreeStatusForRepo: vi.fn().mockResolvedValue(entries),
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("⊞");
      expect(lastFrame()).not.toContain("✓");
    });

    it("should show ✗ flag for upstream gone", async () => {
      const entries = [makeEntry("orphaned", { upstreamGone: true })];
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getWorktreeStatusForRepo: vi.fn().mockResolvedValue(entries),
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("✗");
    });

    it("should navigate worktrees with arrow keys", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { stdin, lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("> main");

      stdin.write("\u001B[B");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("> feature/auth");
    });

    it("should filter worktrees when typing", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { stdin, lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("hotfix");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(1/4 matches)");
      expect(lastFrame()).toContain("hotfix/bug-123");
    });

    it("should expand detail on Enter", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { stdin, lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("\u001B[B"); // Navigate to feature/auth
      await waitForStateUpdate();

      stdin.write("\r"); // Enter to expand
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Modified: 2");
      expect(lastFrame()).toContain("Unpushed commits: 3");
    });

    it("should collapse detail on second Enter", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { stdin, lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("\u001B[B");
      await waitForStateUpdate();

      stdin.write("\r"); // Expand
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Modified: 2");

      stdin.write("\r"); // Collapse
      await waitForStateUpdate();
      expect(lastFrame()).not.toContain("Modified: 2");
    });

    it("should go back to project selection on ESC with multiple repos", async () => {
      const { stdin, lastFrame } = render(<WorktreeStatusView {...defaultProps} />);

      stdin.write("\r"); // Select repo
      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("\x1b"); // ESC
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Select repository");
    });

    it("should close on ESC with single repo", async () => {
      const onClose = vi.fn();
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        onClose,
      };
      const { stdin } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("\x1b");
      await waitForStateUpdate();
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should show error when loading status fails", async () => {
      const failingProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getWorktreeStatusForRepo: vi.fn().mockRejectedValue(new Error("Network error")),
      };
      const { lastFrame } = render(<WorktreeStatusView {...failingProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Error:");
      expect(lastFrame()).toContain("Network error");
    });

    it("should close on any key from error state", async () => {
      const onClose = vi.fn();
      const failingProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getWorktreeStatusForRepo: vi.fn().mockRejectedValue(new Error("fail")),
        onClose,
      };
      const { stdin } = render(<WorktreeStatusView {...failingProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("x");
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("footer navigation hints", () => {
    it("should show navigation hints in project selection", () => {
      const { lastFrame } = render(<WorktreeStatusView {...defaultProps} />);
      expect(lastFrame()).toContain("↑/↓ navigate");
      expect(lastFrame()).toContain("Type to filter");
      expect(lastFrame()).toContain("Enter to select");
      expect(lastFrame()).toContain("ESC");
    });

    it("should show status-specific hints in status view", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Enter to expand");
      expect(lastFrame()).toContain("ESC to close");
    });
  });

  describe("status summary text", () => {
    it("should show summary for modified entries", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("2 changed");
      expect(lastFrame()).toContain("3 unpushed");
    });

    it("should show stash count in summary", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("1 stash");
    });

    it("should show operation type in summary", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("rebase in progress");
    });
  });

  describe("loading state", () => {
    it("should show loading text", async () => {
      const slowResolve = new Promise<WorktreeStatusEntry[]>(() => {});
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getWorktreeStatusForRepo: vi.fn().mockReturnValue(slowResolve),
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();

      expect(lastFrame()).toContain("Loading worktree status...");
    });
  });

  describe("diverged directories", () => {
    const makeDiverged = (overrides: Partial<DivergedDirectoryInfo> = {}): DivergedDirectoryInfo => ({
      name: "2024-01-15-feature-x-abc123",
      path: "/worktrees/.diverged/2024-01-15-feature-x-abc123",
      originalBranch: "feature/x",
      divergedAt: "2024-01-15T10:00:00Z",
      sizeBytes: 1024,
      sizeFormatted: "1.0 KB",
      ...overrides,
    });

    const divergedEntries: DivergedDirectoryInfo[] = [
      makeDiverged(),
      makeDiverged({
        name: "2024-02-20-bugfix-y-def456",
        path: "/worktrees/.diverged/2024-02-20-bugfix-y-def456",
        originalBranch: "bugfix/y",
        divergedAt: "2024-02-20",
        sizeBytes: 2048,
        sizeFormatted: "2.0 KB",
      }),
    ];

    it("should render diverged entries alongside worktrees", async () => {
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getDivergedDirectoriesForRepo: vi.fn().mockResolvedValue(divergedEntries),
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Diverged Directories");
      expect(lastFrame()).toContain("feature/x");
      expect(lastFrame()).toContain("bugfix/y");
    });

    it("should show delete hint when diverged entry is selected", async () => {
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getDivergedDirectoriesForRepo: vi.fn().mockResolvedValue([makeDiverged()]),
        deleteDivergedDirectory: vi.fn().mockResolvedValue(undefined),
      };
      const { stdin, lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      // Navigate past all worktree entries (4 default) + separator to first diverged
      for (let i = 0; i < 5; i++) {
        stdin.write("\u001B[B");
        await waitForStateUpdate();
      }

      expect(lastFrame()).toContain("d to delete");
    });

    it("should show delete confirmation on d key", async () => {
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getWorktreeStatusForRepo: vi.fn().mockResolvedValue([makeEntry("main")]),
        getDivergedDirectoriesForRepo: vi.fn().mockResolvedValue([makeDiverged()]),
        deleteDivergedDirectory: vi.fn().mockResolvedValue(undefined),
      };
      const { stdin, lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      // Navigate past worktree entry + separator to diverged
      stdin.write("\u001B[B");
      await waitForStateUpdate();
      stdin.write("\u001B[B");
      await waitForStateUpdate();

      stdin.write("d");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Delete");
      expect(lastFrame()).toContain("y/n");
    });

    it("should delete on y confirmation", async () => {
      const deleteMock = vi.fn().mockResolvedValue(undefined);
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getWorktreeStatusForRepo: vi.fn().mockResolvedValue([makeEntry("main")]),
        getDivergedDirectoriesForRepo: vi.fn().mockResolvedValue([makeDiverged()]),
        deleteDivergedDirectory: deleteMock,
      };
      const { stdin } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      // Navigate to diverged entry
      stdin.write("\u001B[B");
      await waitForStateUpdate();
      stdin.write("\u001B[B");
      await waitForStateUpdate();

      stdin.write("d");
      await waitForStateUpdate();

      stdin.write("y");
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(deleteMock).toHaveBeenCalledWith(0, "2024-01-15-feature-x-abc123");
    });

    it("should cancel delete on n key", async () => {
      const deleteMock = vi.fn().mockResolvedValue(undefined);
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getWorktreeStatusForRepo: vi.fn().mockResolvedValue([makeEntry("main")]),
        getDivergedDirectoriesForRepo: vi.fn().mockResolvedValue([makeDiverged()]),
        deleteDivergedDirectory: deleteMock,
      };
      const { stdin, lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      // Navigate to diverged entry
      stdin.write("\u001B[B");
      await waitForStateUpdate();
      stdin.write("\u001B[B");
      await waitForStateUpdate();

      stdin.write("d");
      await waitForStateUpdate();

      stdin.write("n");
      await waitForStateUpdate();

      expect(deleteMock).not.toHaveBeenCalled();
      expect(lastFrame()).not.toContain("y/n");
    });

    it("should skip separator during navigation", async () => {
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getWorktreeStatusForRepo: vi.fn().mockResolvedValue([makeEntry("main")]),
        getDivergedDirectoriesForRepo: vi.fn().mockResolvedValue([makeDiverged()]),
      };
      const { stdin, lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      // Start on "main", press down twice (should skip separator)
      stdin.write("\u001B[B");
      await waitForStateUpdate();
      stdin.write("\u001B[B");
      await waitForStateUpdate();

      // Should be on the diverged entry, not stuck on separator
      expect(lastFrame()).toContain("d to delete");
    });

    it("should show diverged directory date formatted", async () => {
      const divergedWithISODate = makeDiverged({
        divergedAt: "2024-06-15T09:30:00Z",
      });
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getDivergedDirectoriesForRepo: vi.fn().mockResolvedValue([divergedWithISODate]),
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      // Should show formatted date (YYYY-MM-DD format from toLocaleDateString("en-CA"))
      expect(lastFrame()).toContain("2024");
    });

    it("should show date-only string as-is", async () => {
      const divergedWithDateOnly = makeDiverged({
        divergedAt: "2024-03-20",
      });
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getDivergedDirectoriesForRepo: vi.fn().mockResolvedValue([divergedWithDateOnly]),
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("2024-03-20");
    });

    it("should show 'unknown date' for empty date string", async () => {
      const divergedNoDate = makeDiverged({
        divergedAt: "",
      });
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getDivergedDirectoriesForRepo: vi.fn().mockResolvedValue([divergedNoDate]),
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("unknown date");
    });

    it("should show diverged directory size", async () => {
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getDivergedDirectoriesForRepo: vi.fn().mockResolvedValue([makeDiverged()]),
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("1.0 KB");
    });

    it("should cancel delete on ESC key", async () => {
      const deleteMock = vi.fn().mockResolvedValue(undefined);
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getWorktreeStatusForRepo: vi.fn().mockResolvedValue([makeEntry("main")]),
        getDivergedDirectoriesForRepo: vi.fn().mockResolvedValue([makeDiverged()]),
        deleteDivergedDirectory: deleteMock,
      };
      const { stdin, lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      // Navigate to diverged entry
      stdin.write("\u001B[B");
      await waitForStateUpdate();
      stdin.write("\u001B[B");
      await waitForStateUpdate();

      stdin.write("d");
      await waitForStateUpdate();

      stdin.write("\x1b"); // ESC cancels
      await waitForStateUpdate();

      expect(deleteMock).not.toHaveBeenCalled();
      expect(lastFrame()).not.toContain("y/n");
    });

    it("should not show delete confirmation footer when not in confirm mode", async () => {
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getDivergedDirectoriesForRepo: vi.fn().mockResolvedValue([makeDiverged()]),
        deleteDivergedDirectory: vi.fn().mockResolvedValue(undefined),
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).not.toContain("y to confirm");
    });

    it("should show confirm footer when in confirm mode", async () => {
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getWorktreeStatusForRepo: vi.fn().mockResolvedValue([makeEntry("main")]),
        getDivergedDirectoriesForRepo: vi.fn().mockResolvedValue([makeDiverged()]),
        deleteDivergedDirectory: vi.fn().mockResolvedValue(undefined),
      };
      const { stdin, lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      // Navigate to diverged entry
      stdin.write("\u001B[B");
      await waitForStateUpdate();
      stdin.write("\u001B[B");
      await waitForStateUpdate();

      stdin.write("d");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("y to confirm");
      expect(lastFrame()).toContain("n or ESC to cancel");
    });

    it("should not show 'd to delete' hint for worktree entries without deleteDivergedDirectory", async () => {
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getDivergedDirectoriesForRepo: vi.fn().mockResolvedValue([makeDiverged()]),
        // deleteDivergedDirectory not provided
      };
      const { stdin, lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      // Navigate to diverged entry
      for (let i = 0; i < 5; i++) {
        stdin.write("\u001B[B");
        await waitForStateUpdate();
      }

      // Without deleteDivergedDirectory, d to delete hint should not appear
      expect(lastFrame()).not.toContain("d to delete");
    });
  });

  describe("empty states", () => {
    it("should show 'No worktrees found' when no entries", async () => {
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getWorktreeStatusForRepo: vi.fn().mockResolvedValue([]),
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("No worktrees found");
    });

    it("should show step number when single repo", async () => {
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();

      // For single repo, step counter should show (Step 1/1)
      expect(lastFrame()).toContain("Step 1/1");
    });

    it("should show step 1/2 in project selection with two repos", () => {
      const { lastFrame } = render(<WorktreeStatusView {...defaultProps} />);
      expect(lastFrame()).toContain("Step 1/2");
    });
  });

  describe("upstream gone status", () => {
    it("should include upstream gone in summary text", async () => {
      const entries = [makeEntry("orphaned-branch", { upstreamGone: true })];
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getWorktreeStatusForRepo: vi.fn().mockResolvedValue(entries),
      };
      const { lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("upstream gone");
    });
  });

  describe("worktree detail expansion", () => {
    it("should show path in detail panel", async () => {
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { stdin, lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("\r"); // Expand first entry (main)
      await waitForStateUpdate();

      expect(lastFrame()).toContain("/worktrees/main");
    });

    it("should show deleted files count in detail", async () => {
      const entries = [
        makeEntry("feature/del", {
          isClean: false,
          canRemove: false,
          reasons: ["uncommitted changes"],
          details: {
            modifiedFiles: 0,
            deletedFiles: 3,
            renamedFiles: 0,
            createdFiles: 0,
            conflictedFiles: 0,
            untrackedFiles: 0,
          },
        }),
      ];
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getWorktreeStatusForRepo: vi.fn().mockResolvedValue(entries),
      };
      const { stdin, lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("\r"); // Expand
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Deleted: 3");
    });

    it("should show upstream gone warning in detail panel", async () => {
      const entries = [makeEntry("orphaned", { upstreamGone: true })];
      const singleRepoProps: WorktreeStatusViewProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getWorktreeStatusForRepo: vi.fn().mockResolvedValue(entries),
      };
      const { stdin, lastFrame } = render(<WorktreeStatusView {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("\r"); // Expand
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Remote branch has been deleted");
    });
  });
});