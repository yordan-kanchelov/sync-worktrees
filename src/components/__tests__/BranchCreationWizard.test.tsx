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

    it("should close wizard on ESC", async () => {
      const onClose = vi.fn();
      const { stdin } = render(<BranchCreationWizard {...defaultProps} onClose={onClose} />);

      stdin.write("\x1b"); // ESC
      await waitForStateUpdate();
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

  describe("index clamping on filter", () => {
    it("should clamp selected index when filter reduces project list", async () => {
      const manyRepos = {
        ...defaultProps,
        repositories: [
          { index: 0, name: "alpha-repo", repoUrl: "https://example.com/alpha.git" },
          { index: 1, name: "beta-repo", repoUrl: "https://example.com/beta.git" },
          { index: 2, name: "gamma-repo", repoUrl: "https://example.com/gamma.git" },
        ],
      };
      const { stdin, lastFrame } = render(<BranchCreationWizard {...manyRepos} />);

      // Navigate to last item
      stdin.write("\u001B[B"); // Down
      stdin.write("\u001B[B"); // Down
      await waitForStateUpdate();
      expect(lastFrame()).toContain("> gamma-repo");

      // Type filter that only matches one repo - index should be clamped
      stdin.write("alpha");
      await waitForStateUpdate();

      // Should still show a valid selection (not crash)
      expect(lastFrame()).toContain("alpha-repo");
    });
  });

  describe("empty-filter navigation", () => {
    it("should keep a valid project selection after filtering to empty then clearing", async () => {
      const getBranchesForRepo = vi.fn().mockResolvedValue(["main"]);
      const props: BranchCreationWizardProps = {
        ...defaultProps,
        repositories: [
          { index: 0, name: "alpha-repo", repoUrl: "https://example.com/alpha.git" },
          { index: 1, name: "beta-repo", repoUrl: "https://example.com/beta.git" },
        ],
        getBranchesForRepo,
      };
      const { stdin, lastFrame } = render(<BranchCreationWizard {...props} />);

      stdin.write("zz");
      await waitForStateUpdate();
      stdin.write("\u001B[B"); // down arrow while filter empty
      await waitForStateUpdate();
      stdin.write("\u007F"); // backspace
      stdin.write("\u007F"); // backspace
      await waitForStateUpdate();

      stdin.write("\r"); // Enter
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(getBranchesForRepo).toHaveBeenCalled();
      expect(getBranchesForRepo.mock.calls[0][0]).toBeGreaterThanOrEqual(0);
      expect(lastFrame()).toContain("Select base branch");
    });

    it("should keep a valid branch selection after filtering to empty then clearing", async () => {
      const getBranchesForRepo = vi.fn().mockResolvedValue(["main", "develop", "feature/test"]);
      const props: BranchCreationWizardProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "single-repo", repoUrl: "https://example.com/repo.git" }],
        getBranchesForRepo,
      };
      const { stdin, lastFrame } = render(<BranchCreationWizard {...props} />);

      await waitForStateUpdate();
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Select base branch");

      stdin.write("zzz");
      await waitForStateUpdate();
      stdin.write("\u001B[B");
      await waitForStateUpdate();
      stdin.write("\u007F");
      stdin.write("\u007F");
      stdin.write("\u007F");
      await waitForStateUpdate();

      stdin.write("\r");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Enter new branch name");
    });
  });

  describe("repo index correctness", () => {
    it("should use correct repo index when filter is active", async () => {
      const createAndPushBranch = vi.fn().mockResolvedValue({ success: true, finalName: "new-branch" });
      const onBranchCreated = vi.fn();
      const getBranchesForRepo = vi.fn().mockResolvedValue(["main", "develop"]);
      const getDefaultBranchForRepo = vi.fn().mockReturnValue("main");
      const props: BranchCreationWizardProps = {
        ...defaultProps,
        repositories: [
          { index: 0, name: "alpha-repo", repoUrl: "https://example.com/alpha.git" },
          { index: 1, name: "beta-repo", repoUrl: "https://example.com/beta.git" },
          { index: 2, name: "gamma-repo", repoUrl: "https://example.com/gamma.git" },
        ],
        getBranchesForRepo,
        getDefaultBranchForRepo,
        createAndPushBranch,
        onBranchCreated,
      };

      const { stdin, lastFrame } = render(<BranchCreationWizard {...props} />);

      // Type "g" to filter to gamma-repo (index 2)
      stdin.write("g");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("gamma-repo");

      // Press Enter to select gamma-repo
      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();
      await waitForStateUpdate();

      // Verify branches loaded for correct repo
      expect(getBranchesForRepo).toHaveBeenCalledWith(2);
      expect(lastFrame()).toContain("Select base branch");

      // Select base branch
      stdin.write("\r");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Enter new branch name");

      // Type branch name character by character to ensure proper state updates
      for (const char of "my-feature") {
        stdin.write(char);
      }
      await waitForStateUpdate();

      // Press Enter to create
      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(createAndPushBranch).toHaveBeenCalledWith(2, "main", "my-feature");
      expect(onBranchCreated).toHaveBeenCalledWith(
        expect.objectContaining({ repoIndex: 2 }),
      );
    });
  });

  describe("footer navigation hints", () => {
    it("should show navigation hints in selection steps", () => {
      const { lastFrame } = render(<BranchCreationWizard {...defaultProps} />);
      expect(lastFrame()).toContain("↑/↓ navigate");
      expect(lastFrame()).toContain("Type to filter");
      expect(lastFrame()).toContain("Enter to select");
      expect(lastFrame()).toContain("ESC");
      expect(lastFrame()).toContain("cancel");
    });
  });
});
