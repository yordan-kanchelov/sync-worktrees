import React from "react";
import { render, cleanup } from "ink-testing-library";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { BranchCreationWizardProps } from "../BranchCreationWizard";
import BranchCreationWizard from "../BranchCreationWizard";

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
      getDefaultBranchForRepo: vi.fn().mockResolvedValue("main"),
      createAndPushBranch: vi.fn().mockResolvedValue({ success: true, finalName: "new-branch" }),
      onClose: vi.fn(),
      onComplete: vi.fn(),
    };
  });

  afterEach(() => {
    cleanup();
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

      stdin.write("\u001B[B");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("> repo-2");
    });

    it("should navigate up with arrow key", async () => {
      const { stdin, lastFrame } = render(<BranchCreationWizard {...defaultProps} />);

      stdin.write("\u001B[B");
      await waitForStateUpdate();
      stdin.write("\u001B[A");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("> repo-1");
    });

    it("should proceed to branch selection on Enter", async () => {
      const { stdin, lastFrame } = render(<BranchCreationWizard {...defaultProps} />);

      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Select base branch");
    });

    it("should close wizard on ESC", async () => {
      const onClose = vi.fn();
      const { stdin } = render(<BranchCreationWizard {...defaultProps} onClose={onClose} />);

      stdin.write("\x1b");
      await waitForStateUpdate();
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("branch selection", () => {
    it("should show branches after project selection", async () => {
      const { stdin, lastFrame } = render(<BranchCreationWizard {...defaultProps} />);

      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("main");
      expect(lastFrame()).toContain("develop");
    });

    it("should pre-select and mark the default branch when it is not the first one", async () => {
      const props: BranchCreationWizardProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "single-repo", repoUrl: "https://example.com/repo.git" }],
        getBranchesForRepo: vi.fn().mockResolvedValue(["main", "develop"]),
        getDefaultBranchForRepo: vi.fn().mockResolvedValue("develop"),
      };
      const { lastFrame } = render(<BranchCreationWizard {...props} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("> develop (default)");
      expect(lastFrame()).not.toContain("> main");
    });

    it("should keep the branch list when the default branch cannot be resolved", async () => {
      const props: BranchCreationWizardProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "single-repo", repoUrl: "https://example.com/repo.git" }],
        getBranchesForRepo: vi.fn().mockResolvedValue(["main", "develop"]),
        getDefaultBranchForRepo: vi.fn().mockRejectedValue(new Error("ls-remote failed")),
      };
      const { lastFrame } = render(<BranchCreationWizard {...props} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("> main");
      expect(lastFrame()).toContain("develop");
      expect(lastFrame()).not.toContain("(default)");
    });

    it("should drop a trailing newline from a pasted filter", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { stdin, lastFrame } = render(<BranchCreationWizard {...singleRepoProps} />);

      await waitForStateUpdate();
      expect(lastFrame()).toContain("Select base branch");

      stdin.write("\u001B[200~main\n\u001B[201~");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("> main");
      expect(lastFrame()).not.toContain("No matches");
    });

    it("should go back to project selection on ESC", async () => {
      const { stdin, lastFrame } = render(<BranchCreationWizard {...defaultProps} />);

      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("\x1b");
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
      stdin.write("\r");
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
      stdin.write("\r");
      await waitForStateUpdate();

      stdin.write("\x1b");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Select base branch");
    });

    it("should sanitize a pasted branch name, dropping disallowed characters", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { stdin, lastFrame } = render(<BranchCreationWizard {...singleRepoProps} />);

      await waitForStateUpdate();
      stdin.write("\r");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Enter new branch name");

      stdin.write("\u001B[200~feature/new thing!\u001B[201~");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("feature/newthing");

      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(singleRepoProps.createAndPushBranch).toHaveBeenCalledWith(0, "main", "feature/newthing");
    });
  });

  describe("colliding name", () => {
    const singleRepo = (overrides: Partial<BranchCreationWizardProps> = {}): BranchCreationWizardProps => ({
      ...defaultProps,
      repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      getBranchesForRepo: vi.fn().mockResolvedValue(["x"]),
      getDefaultBranchForRepo: vi.fn().mockResolvedValue("x"),
      ...overrides,
    });

    it("submits the suffixed name it displayed, not the name that was typed", async () => {
      const props = singleRepo();
      const { stdin, lastFrame } = render(<BranchCreationWizard {...props} />);

      await waitForStateUpdate();
      stdin.write("\r");
      await waitForStateUpdate();

      stdin.write("x");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Name exists, will create:");
      expect(lastFrame()).toContain("x-1");

      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(props.createAndPushBranch).toHaveBeenCalledWith(0, "x", "x-1");
    });

    it("keeps walking the suffix until the name is free", async () => {
      const props = singleRepo({ getBranchesForRepo: vi.fn().mockResolvedValue(["x", "x-1", "x-2"]) });
      const { stdin, lastFrame } = render(<BranchCreationWizard {...props} />);

      await waitForStateUpdate();
      stdin.write("\r");
      await waitForStateUpdate();

      stdin.write("x");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("x-3");

      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(props.createAndPushBranch).toHaveBeenCalledWith(0, "x", "x-3");
    });

    it("submits the typed name unchanged when nothing collides", async () => {
      const props = singleRepo();
      const { stdin, lastFrame } = render(<BranchCreationWizard {...props} />);

      await waitForStateUpdate();
      stdin.write("\r");
      await waitForStateUpdate();

      stdin.write("y");
      await waitForStateUpdate();
      expect(lastFrame()).not.toContain("Name exists");

      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(props.createAndPushBranch).toHaveBeenCalledWith(0, "x", "y");
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

      stdin.write("\u001B[B");
      stdin.write("\u001B[B");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("> gamma-repo");

      stdin.write("alpha");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("> alpha-repo");
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
      stdin.write("\u001B[B");
      await waitForStateUpdate();
      stdin.write("\u007F");
      stdin.write("\u007F");
      await waitForStateUpdate();

      stdin.write("\r");
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
      const getDefaultBranchForRepo = vi.fn().mockResolvedValue("main");
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

      stdin.write("g");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("gamma-repo");

      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(getBranchesForRepo).toHaveBeenCalledWith(2);
      expect(lastFrame()).toContain("Select base branch");

      stdin.write("\r");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Enter new branch name");

      for (const char of "my-feature") {
        stdin.write(char);
      }
      await waitForStateUpdate();

      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(createAndPushBranch).toHaveBeenCalledWith(2, "main", "my-feature");
      expect(onBranchCreated).toHaveBeenCalledWith(expect.objectContaining({ repoIndex: 2 }));
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

  describe("a late load for a repository the user left", () => {
    it("keeps the second repository's branches and creates the branch there", async () => {
      let resolveA: (branches: string[]) => void = () => {};
      const getBranchesForRepo = vi.fn((index: number) =>
        index === 0
          ? new Promise<string[]>((resolve) => {
              resolveA = resolve;
            })
          : Promise.resolve(["b-main"]),
      );
      const getDefaultBranchForRepo = vi.fn(async (index: number) => (index === 0 ? "a-base" : "b-main"));
      const createAndPushBranch = vi.fn().mockResolvedValue({ success: true, finalName: "topic" });
      const { stdin, lastFrame } = render(
        <BranchCreationWizard
          {...defaultProps}
          getBranchesForRepo={getBranchesForRepo}
          getDefaultBranchForRepo={getDefaultBranchForRepo}
          createAndPushBranch={createAndPushBranch}
        />,
      );

      stdin.write("\r");
      await waitForStateUpdate();
      stdin.write("\u001B");
      await waitForStateUpdate();
      stdin.write("\u001B[B");
      await waitForStateUpdate();
      stdin.write("\r");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("b-main");

      resolveA(["a-base"]);
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("b-main");
      expect(lastFrame()).not.toContain("a-base");

      stdin.write("\r");
      await waitForStateUpdate();
      for (const char of "topic") stdin.write(char);
      await waitForStateUpdate();
      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(createAndPushBranch).toHaveBeenCalledTimes(1);
      expect(createAndPushBranch).toHaveBeenCalledWith(1, "b-main", "topic");
    });
  });
});
