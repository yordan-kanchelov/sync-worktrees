import React from "react";
import { render, cleanup } from "ink-testing-library";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { OpenEditorWizardProps } from "../OpenEditorWizard";
import OpenEditorWizard from "../OpenEditorWizard";

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
      openTerminalInWorktree: vi.fn().mockReturnValue({ success: true }),
      onClose: vi.fn(),
    };
  });

  afterEach(() => {
    cleanup();
  });

  describe("rendering", () => {
    it("should render wizard title", () => {
      const { lastFrame } = render(<OpenEditorWizard {...defaultProps} />);
      expect(lastFrame()).toContain("Open Worktree");
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

      stdin.write("\u001B[B");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("> repo-2");
    });

    it("should navigate up with arrow key", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("\u001B[B");
      await waitForStateUpdate();
      stdin.write("\u001B[A");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("> repo-1");
    });

    it("should proceed to worktree selection on Enter", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Select worktree");
    });

    it("should close wizard on ESC", async () => {
      const onClose = vi.fn();
      const { stdin } = render(<OpenEditorWizard {...defaultProps} onClose={onClose} />);

      stdin.write("\x1b");
      await waitForStateUpdate();
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("fzf filtering - project selection", () => {
    it("should filter projects when typing", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("2");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(1/2 matches)");
      expect(lastFrame()).toContain("repo-2");
    });

    it("should show no matches when filter has no results", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("xyz");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(0/2 matches)");
      expect(lastFrame()).toContain("No matches");
    });

    it("should remove filter character on backspace", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("xy");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("(0/2 matches)");

      stdin.write("\x7f");
      await waitForStateUpdate();
      stdin.write("\x7f");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(2/2 matches)");
    });

    it("should reset selection index when filtering", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("\u001B[B");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("> repo-2");

      stdin.write("1");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("> repo-1");
    });
  });

  describe("worktree selection", () => {
    it("should show worktrees after project selection", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("main");
      expect(lastFrame()).toContain("develop");
    });

    it("should show filter with match count for worktrees", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(3/3 matches)");
    });

    it("should go back to project selection on ESC", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("\x1b");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Select repository");
    });
  });

  describe("fzf filtering - worktree selection", () => {
    it("should filter worktrees when typing", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("feat");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(1/3 matches)");
    });

    it("should drop a trailing newline from a pasted filter", async () => {
      const { stdin, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("\r");
      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("\u001B[200~main\n\u001B[201~");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(1/3 matches)");
      expect(lastFrame()).toContain("> main");
      expect(lastFrame()).not.toContain("No matches");
    });
  });

  describe("opening worktree", () => {
    it("should default to terminal mode", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { lastFrame } = render(<OpenEditorWizard {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Terminal (tmux)");
      expect(lastFrame()).toContain("Tab to switch to Editor");
    });

    it("should call openTerminalInWorktree by default with repo index and branch", async () => {
      const openTerminalInWorktree = vi.fn().mockReturnValue({ success: true });
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "my-repo", repoUrl: "https://example.com/repo.git" }],
        openTerminalInWorktree,
      };
      const { stdin } = render(<OpenEditorWizard {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("\r");
      await waitForStateUpdate();

      expect(openTerminalInWorktree).toHaveBeenCalledWith(0, "/worktrees/main", "main");
    });

    it("should toggle to editor mode on Tab", async () => {
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { stdin, lastFrame } = render(<OpenEditorWizard {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("\t");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Mode:");
      expect(lastFrame()).toContain("Editor");
      expect(lastFrame()).toContain("Tab to switch to Terminal");
    });

    it("should call openEditorInWorktree when in editor mode", async () => {
      const openEditorInWorktree = vi.fn().mockReturnValue({ success: true });
      const openTerminalInWorktree = vi.fn().mockReturnValue({ success: true });
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        openEditorInWorktree,
        openTerminalInWorktree,
      };
      const { stdin } = render(<OpenEditorWizard {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("\t");
      await waitForStateUpdate();
      stdin.write("\r");
      await waitForStateUpdate();

      expect(openEditorInWorktree).toHaveBeenCalledWith("/worktrees/main");
      expect(openTerminalInWorktree).not.toHaveBeenCalled();
    });

    it("should call onClose after opening", async () => {
      const onClose = vi.fn();
      const singleRepoProps = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
        onClose,
      };
      const { stdin } = render(<OpenEditorWizard {...singleRepoProps} />);

      await waitForStateUpdate();
      await waitForStateUpdate();

      stdin.write("\r");
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

  describe("empty worktree list", () => {
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    it("loads once and stays on the empty state", async () => {
      const getWorktreesForRepo = vi.fn(async () => {
        await delay(20);
        return [];
      });
      const { lastFrame } = render(
        <OpenEditorWizard
          {...defaultProps}
          repositories={[{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }]}
          getWorktreesForRepo={getWorktreesForRepo}
        />,
      );

      await delay(500);

      expect(getWorktreesForRepo).toHaveBeenCalledTimes(1);
      expect(lastFrame()).toContain("No worktrees found");
    });

    it("loads once although the loader prop is a new function on every render", async () => {
      const load = vi.fn(async (repoIndex: number) => {
        expect(repoIndex).toBe(0);
        await delay(20);
        return [];
      });
      const props = {
        ...defaultProps,
        repositories: [{ index: 0, name: "repo", repoUrl: "https://example.com/repo.git" }],
      };
      const { rerender, lastFrame } = render(
        <OpenEditorWizard {...props} getWorktreesForRepo={(index) => load(index)} />,
      );

      for (let i = 0; i < 10; i++) {
        rerender(<OpenEditorWizard {...props} getWorktreesForRepo={(index) => load(index)} />);
        await delay(20);
      }

      expect(load).toHaveBeenCalledTimes(1);
      expect(lastFrame()).toContain("No worktrees found");
    });

    it("does not flash the empty state between the keypress and the load", async () => {
      const getWorktreesForRepo = vi.fn(async () => {
        await delay(50);
        return [];
      });
      const { stdin, frames } = render(
        <OpenEditorWizard {...defaultProps} getWorktreesForRepo={getWorktreesForRepo} />,
      );

      stdin.write("\r");
      await delay(20);
      expect(frames.some((frame) => frame.includes("No worktrees found"))).toBe(false);

      await delay(300);
      expect(frames.some((frame) => frame.includes("No worktrees found"))).toBe(true);
      expect(getWorktreesForRepo).toHaveBeenCalledTimes(1);
    });

    it("loads again when the same repository is picked a second time", async () => {
      const getWorktreesForRepo = vi.fn(async () => {
        await delay(20);
        return [];
      });
      const { stdin, lastFrame } = render(
        <OpenEditorWizard {...defaultProps} getWorktreesForRepo={getWorktreesForRepo} />,
      );

      stdin.write("\r");
      await delay(300);
      expect(getWorktreesForRepo).toHaveBeenCalledTimes(1);

      stdin.write("\u001B");
      await waitForStateUpdate();
      stdin.write("\r");
      await delay(300);

      expect(getWorktreesForRepo).toHaveBeenCalledTimes(2);
      expect(getWorktreesForRepo).toHaveBeenLastCalledWith(0);
      expect(lastFrame()).toContain("No worktrees found");
    });

    it("loads once more when another repository is selected", async () => {
      const getWorktreesForRepo = vi.fn(async () => {
        await delay(20);
        return [];
      });
      const { stdin, lastFrame } = render(
        <OpenEditorWizard {...defaultProps} getWorktreesForRepo={getWorktreesForRepo} />,
      );

      stdin.write("\r");
      await delay(300);
      expect(getWorktreesForRepo).toHaveBeenCalledTimes(1);
      expect(getWorktreesForRepo).toHaveBeenLastCalledWith(0);

      stdin.write("\u001B");
      await waitForStateUpdate();
      stdin.write("\u001B[B");
      await waitForStateUpdate();
      stdin.write("\r");
      await delay(300);

      expect(getWorktreesForRepo).toHaveBeenCalledTimes(2);
      expect(getWorktreesForRepo).toHaveBeenLastCalledWith(1);
      expect(lastFrame()).toContain("No worktrees found");
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

  describe("selection edge cases", () => {
    it("loads the one repository by its own index, not by position", async () => {
      const getWorktreesForRepo = vi.fn().mockResolvedValue([{ path: "/worktrees/main", branch: "main" }]);
      render(
        <OpenEditorWizard
          {...defaultProps}
          repositories={[{ index: 3, name: "only", repoUrl: "https://example.com/only.git" }]}
          getWorktreesForRepo={getWorktreesForRepo}
        />,
      );

      await waitForStateUpdate();
      expect(getWorktreesForRepo).toHaveBeenCalledWith(3);
    });

    it("keeps a valid selection when down is pressed on an empty filtered list", async () => {
      const { stdin, rerender, lastFrame } = render(<OpenEditorWizard {...defaultProps} />);

      stdin.write("new");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("No matches");

      stdin.write("\u001B[B");
      await waitForStateUpdate();

      rerender(
        <OpenEditorWizard
          {...defaultProps}
          repositories={[...defaultProps.repositories, { index: 2, name: "new-repo", repoUrl: "u" }]}
        />,
      );
      await waitForStateUpdate();
      expect(lastFrame()).toContain("> new-repo");

      stdin.write("\r");
      await waitForStateUpdate();
      expect(defaultProps.getWorktreesForRepo).toHaveBeenCalledWith(2);
    });
  });

  describe("a late load for a repository the user left", () => {
    it("keeps the second repository's worktrees and opens one of them", async () => {
      let resolveA: (worktrees: Array<{ path: string; branch: string }>) => void = () => {};
      const getWorktreesForRepo = vi.fn((index: number) =>
        index === 0
          ? new Promise<Array<{ path: string; branch: string }>>((resolve) => {
              resolveA = resolve;
            })
          : Promise.resolve([{ path: "/b/b-main", branch: "b-main" }]),
      );
      const openTerminalInWorktree = vi.fn().mockReturnValue({ success: true });
      const { stdin, lastFrame } = render(
        <OpenEditorWizard
          {...defaultProps}
          getWorktreesForRepo={getWorktreesForRepo}
          openTerminalInWorktree={openTerminalInWorktree}
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

      resolveA([{ path: "/a/a-main", branch: "a-main" }]);
      await waitForStateUpdate();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("b-main");
      expect(lastFrame()).not.toContain("a-main");

      stdin.write("\r");
      await waitForStateUpdate();

      expect(openTerminalInWorktree).toHaveBeenCalledTimes(1);
      expect(openTerminalInWorktree).toHaveBeenCalledWith(1, "/b/b-main", "b-main");
    });
  });
});
