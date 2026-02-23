import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect, vi, beforeEach } from "vitest";

import WorktreeStatusView, { WorktreeStatusViewProps } from "../WorktreeStatusView";
import type { WorktreeStatusResult } from "../../services/worktree-status.service";
import type { WorktreeStatusEntry } from "../../types";

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

    it("should close on ESC", () => {
      const onClose = vi.fn();
      const { stdin } = render(<WorktreeStatusView {...defaultProps} onClose={onClose} />);

      stdin.write("\x1b");
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
});
