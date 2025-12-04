import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect, vi, beforeEach } from "vitest";

import BranchCreationWizard, { BranchCreationWizardProps } from "../BranchCreationWizard";

const waitForStateUpdate = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("BranchCreationWizard", () => {
  let defaultProps: BranchCreationWizardProps;

  beforeEach(() => {
    defaultProps = {
      repositories: [
        { index: 0, name: "repo-1", repoUrl: "https://example.com/repo-1.git" },
        { index: 1, name: "repo-2", repoUrl: "https://example.com/repo-2.git" },
      ],
      getBranchesForRepo: vi.fn().mockResolvedValue(["main", "develop", "feature/test"]),
      getDefaultBranchForRepo: vi.fn().mockReturnValue("main"),
      createAndPushBranch: vi.fn().mockResolvedValue({ success: true, finalName: "new-branch" }),
      onClose: vi.fn(),
      onComplete: vi.fn(),
    };
  });

  describe("rendering", () => {
    it("should render wizard title", () => {
      const { lastFrame } = render(<BranchCreationWizard {...defaultProps} />);
      expect(lastFrame()).toContain("Create New Branch");
    });

    it("should show project selection when multiple repositories", () => {
      const { lastFrame } = render(<BranchCreationWizard {...defaultProps} />);
      expect(lastFrame()).toContain("Select repository");
      expect(lastFrame()).toContain("repo-1");
      expect(lastFrame()).toContain("repo-2");
    });

    it("should skip project selection with single repository", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "single-repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { lastFrame } = render(<BranchCreationWizard {...singleRepoProps} />);

      await waitForStateUpdate();
      expect(lastFrame()).toContain("Select base branch");
    });
  });

  describe("project selection", () => {
    it("should highlight selected project", () => {
      const { lastFrame } = render(<BranchCreationWizard {...defaultProps} />);
      expect(lastFrame()).toContain("> repo-1");
    });

    it("should navigate down with arrow key", async () => {
      const { stdin, lastFrame } = render(<BranchCreationWizard {...defaultProps} />);

      stdin.write("\u001B[B"); // Down arrow
      await waitForStateUpdate();

      expect(lastFrame()).toContain("> repo-2");
    });

    it("should navigate up with arrow key", async () => {
      const { stdin, lastFrame } = render(<BranchCreationWizard {...defaultProps} />);

      stdin.write("\u001B[B"); // Down arrow
      await waitForStateUpdate();
      stdin.write("\u001B[A"); // Up arrow
      await waitForStateUpdate();

      expect(lastFrame()).toContain("> repo-1");
    });

    it("should proceed to branch selection on Enter", async () => {
      const { stdin, lastFrame } = render(<BranchCreationWizard {...defaultProps} />);

      stdin.write("\r"); // Enter
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Select base branch");
    });

    it("should close wizard on ESC", () => {
      const onClose = vi.fn();
      const { stdin } = render(<BranchCreationWizard {...defaultProps} onClose={onClose} />);

      stdin.write("\x1b"); // ESC
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("branch selection", () => {
    it("should show branches after project selection", async () => {
      const { stdin, lastFrame } = render(<BranchCreationWizard {...defaultProps} />);

      stdin.write("\r"); // Enter to select project
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("main");
      expect(lastFrame()).toContain("develop");
    });

    it("should highlight default branch", async () => {
      const { stdin, lastFrame } = render(<BranchCreationWizard {...defaultProps} />);

      stdin.write("\r"); // Enter
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(default)");
    });

    it("should go back to project selection on ESC", async () => {
      const { stdin, lastFrame } = render(<BranchCreationWizard {...defaultProps} />);

      stdin.write("\r"); // Enter to select project
      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("\x1b"); // ESC
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Select repository");
    });
  });

  describe("name input", () => {
    it("should show name input step after branch selection", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { stdin, lastFrame } = render(<BranchCreationWizard {...singleRepoProps} />);

      await waitForStateUpdate();
      stdin.write("\r"); // Select branch
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Enter new branch name");
      expect(lastFrame()).toContain("Base branch:");
    });

    it("should go back to branch selection on ESC", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { stdin, lastFrame } = render(<BranchCreationWizard {...singleRepoProps} />);

      await waitForStateUpdate();
      stdin.write("\r"); // Select branch
      await waitForStateUpdate();

      stdin.write("\x1b"); // ESC
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Select base branch");
    });
  });

  describe("footer navigation hints", () => {
    it("should show navigation hints in selection steps", () => {
      const { lastFrame } = render(<BranchCreationWizard {...defaultProps} />);
      expect(lastFrame()).toContain("↑/↓ to navigate");
      expect(lastFrame()).toContain("Enter to select");
      expect(lastFrame()).toContain("ESC to cancel");
    });
  });
});
