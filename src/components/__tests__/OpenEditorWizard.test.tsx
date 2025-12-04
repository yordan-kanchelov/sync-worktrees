import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect, vi, beforeEach } from "vitest";

import OpenEditorWizard, { OpenEditorWizardProps } from "../OpenEditorWizard";

const waitForStateUpdate = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("OpenEditorWizard", () => {
  let defaultProps: OpenEditorWizardProps;

  beforeEach(() => {
    defaultProps = {
      repositories: [
        { index: 0, name: "repo-1", repoUrl: "https://example.com/repo-1.git" },
        { index: 1, name: "repo-2", repoUrl: "https://example.com/repo-2.git" },
      ],
      getWorktreesForRepo: vi.fn().mockResolvedValue([
        { path: "/worktrees/main", branch: "main" },
        { path: "/worktrees/develop", branch: "develop" },
        { path: "/worktrees/feature-auth", branch: "feature/auth" },
      ]),
      openEditorInWorktree: vi.fn().mockReturnValue({ success: true }),
      onClose: vi.fn(),
    };
  });

  describe("rendering", () => {
    it("should render wizard title", () => {
      const { lastFrame } = render(<OpenEditorWizard {...defaultProps} />);
      expect(lastFrame()).toContain("Open in Editor");
    });

    it("should show project selection when multiple repositories", () => {
      const { lastFrame } = render(<OpenEditorWizard {...defaultProps} />);
      expect(lastFrame()).toContain("Select repository");
      expect(lastFrame()).toContain("repo-1");
      expect(lastFrame()).toContain("repo-2");
    });

    it("should skip project selection with single repository", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "single-repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { lastFrame } = render(<OpenEditorWizard {...singleRepoProps} />);

      await waitForStateUpdate();
      expect(lastFrame()).toContain("Select worktree");
    });

    it("should show filter input with match count", () => {
      const { lastFrame } = render(<OpenEditorWizard {...defaultProps} />);
      expect(lastFrame()).toContain("Filter:");
      expect(lastFrame()).toContain("(2/2 matches)");
    });
  });

  describe("project selection", () => {
    it("should highlight selected project", () => {
      const { lastFrame } = render(<OpenEditorWizard {...defaultProps} />);
      expect(lastFrame()).toContain("> repo-1");
    });

    it("should navigate down with arrow key", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("\u001B[B"); // Down arrow
      await waitForStateUpdate();

      expect(lastFrame()).toContain("> repo-2");
    });

    it("should navigate up with arrow key", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("\u001B[B"); // Down arrow
      await waitForStateUpdate();
      stdin.write("\u001B[A"); // Up arrow
      await waitForStateUpdate();

      expect(lastFrame()).toContain("> repo-1");
    });

    it("should proceed to worktree selection on Enter", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("\r"); // Enter
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Select worktree");
    });

    it("should close wizard on ESC", () => {
      const onClose = vi.fn();
      const { stdin } = render(<OpenEditorWizard {...defaultProps} onClose={onClose} />);

      stdin.write("\x1b"); // ESC
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("fzf filtering - project selection", () => {
    it("should filter projects when typing", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("2"); // Type "2"
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(1/2 matches)");
      expect(lastFrame()).toContain("repo-2");
    });

    it("should show no matches when filter has no results", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("xyz"); // Type something that doesn't match
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(0/2 matches)");
      expect(lastFrame()).toContain("No matches");
    });

    it("should remove filter character on backspace", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("xy"); // Type "xy"
      await waitForStateUpdate();
      expect(lastFrame()).toContain("(0/2 matches)");

      stdin.write("\x7f"); // Backspace
      await waitForStateUpdate();
      stdin.write("\x7f"); // Backspace again
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(2/2 matches)");
    });

    it("should reset selection index when filtering", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("\u001B[B"); // Down arrow to select repo-2
      await waitForStateUpdate();
      expect(lastFrame()).toContain("> repo-2");

      stdin.write("1"); // Filter to show only repo-1
      await waitForStateUpdate();

      expect(lastFrame()).toContain("> repo-1");
    });
  });

  describe("worktree selection", () => {
    it("should show worktrees after project selection", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("\r"); // Enter to select project
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("main");
      expect(lastFrame()).toContain("develop");
    });

    it("should show filter with match count for worktrees", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("\r"); // Enter
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(3/3 matches)");
    });

    it("should go back to project selection on ESC", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("\r"); // Enter to select project
      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("\x1b"); // ESC
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Select repository");
    });
  });

  describe("fzf filtering - worktree selection", () => {
    it("should filter worktrees when typing", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("\r"); // Enter to select project
      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("feat"); // Type "feat"
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(1/3 matches)");
    });
  });

  describe("opening editor", () => {
    it("should call openEditorInWorktree on selection", async () => {
      const openEditorInWorktree = vi.fn().mockReturnValue({ success: true });
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        openEditorInWorktree,
      };
      const { stdin } = render(<OpenEditorWizard {...singleRepoProps} />);

      await waitForStateUpdate(); // Wait for worktrees to load
      await waitForStateUpdate();

      stdin.write("\r"); // Enter to select worktree
      await waitForStateUpdate();

      expect(openEditorInWorktree).toHaveBeenCalledWith("/worktrees/main");
    });

    it("should call onClose after opening editor", async () => {
      const onClose = vi.fn();
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        onClose,
      };
      const { stdin } = render(<OpenEditorWizard {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("\r"); // Enter
      await waitForStateUpdate();

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should show error when loading worktrees fails", async () => {
      const failingProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        getWorktreesForRepo: vi.fn().mockRejectedValue(new Error("Network error")),
      };
      const { lastFrame } = render(<OpenEditorWizard {...failingProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Error:");
      expect(lastFrame()).toContain("Network error");
    });
  });

  describe("footer navigation hints", () => {
    it("should show navigation hints in selection steps", () => {
      const { lastFrame } = render(<OpenEditorWizard {...defaultProps} />);
      expect(lastFrame()).toContain("↑/↓ navigate");
      expect(lastFrame()).toContain("Type to filter");
      expect(lastFrame()).toContain("Enter to select");
      expect(lastFrame()).toContain("ESC");
      expect(lastFrame()).toContain("cancel");
    });
  });
});
