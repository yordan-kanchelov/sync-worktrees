import React from "react";
import { render, cleanup } from "ink-testing-library";
import { describe, it, expect, vi, afterEach } from "vitest";

import BranchCreationWizard from "../BranchCreationWizard";
import OpenEditorWizard from "../OpenEditorWizard";
import WorktreeStatusView from "../WorktreeStatusView";
import type { WorktreeStatusResult } from "../../services/worktree-status.service";
import type { DivergedDirectoryInfo } from "../../types";

const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 100));

const CTRL_N = "\u000E";
const CTRL_P = "\u0010";
const CTRL_D = "\u0004";
const DOWN = "\u001B[B";

const repositories = [
  { index: 0, name: "alpha", repoUrl: "https://example.com/alpha.git" },
  { index: 1, name: "bravo", repoUrl: "https://example.com/bravo.git" },
  { index: 2, name: "charlie", repoUrl: "https://example.com/charlie.git" },
];

const selected = (frame: string | undefined): string | undefined => frame?.match(/> (\S+)/)?.[1];

const status: WorktreeStatusResult = {
  isClean: true,
  hasUnpushedCommits: false,
  hasStashedChanges: false,
  hasOperationInProgress: false,
  hasModifiedSubmodules: false,
  upstreamGone: false,
  fullyPushedUpstreamDeleted: false,
  canRemove: true,
  reasons: [],
  divergence: null,
};

const diverged: DivergedDirectoryInfo = {
  name: "2024-01-15-feature-x-abc123",
  path: "/worktrees/.diverged/2024-01-15-feature-x-abc123",
  originalBranch: "feature/x",
  divergedAt: "2024-01-15T10:00:00Z",
  sizeBytes: 1024,
  sizeFormatted: "1.0 KB",
};

describe("list keys", () => {
  afterEach(() => {
    cleanup();
  });

  describe("Ctrl-N / Ctrl-P", () => {
    it("moves through the open wizard's list without typing into its filter", async () => {
      const { stdin, lastFrame } = render(
        <OpenEditorWizard
          repositories={repositories}
          getWorktreesForRepo={vi.fn().mockResolvedValue([])}
          openEditorInWorktree={vi.fn()}
          openTerminalInWorktree={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      await settle();

      stdin.write(CTRL_N);
      await settle();
      stdin.write(CTRL_N);
      await settle();
      expect(selected(lastFrame())).toBe("charlie");
      expect(lastFrame()).toContain("Filter: _");

      stdin.write(CTRL_P);
      await settle();
      expect(selected(lastFrame())).toBe("bravo");
    });

    it("moves through the branch wizard's lists", async () => {
      const { stdin, lastFrame } = render(
        <BranchCreationWizard
          repositories={repositories}
          getBranchesForRepo={vi.fn().mockResolvedValue(["main", "develop", "release"])}
          getDefaultBranchForRepo={vi.fn().mockResolvedValue("main")}
          createAndPushBranch={vi.fn()}
          onClose={vi.fn()}
          onComplete={vi.fn()}
        />,
      );
      await settle();

      stdin.write(CTRL_N);
      await settle();
      expect(selected(lastFrame())).toBe("bravo");

      stdin.write("\r");
      await settle();
      stdin.write(CTRL_N);
      await settle();
      stdin.write(CTRL_N);
      await settle();
      stdin.write(CTRL_P);
      await settle();
      expect(selected(lastFrame())).toBe("develop");
      expect(lastFrame()).toContain("Filter: _");
    });

    it("moves through the worktree status list", async () => {
      const { stdin, lastFrame } = render(
        <WorktreeStatusView
          repositories={repositories.slice(0, 1)}
          getWorktreeStatusForRepo={vi.fn().mockResolvedValue([
            { branch: "main", path: "/worktrees/main", status },
            { branch: "develop", path: "/worktrees/develop", status },
          ])}
          onClose={vi.fn()}
        />,
      );
      await settle();

      stdin.write(CTRL_N);
      await settle();
      expect(selected(lastFrame())).toBe("develop");

      stdin.write(CTRL_P);
      await settle();
      expect(selected(lastFrame())).toBe("main");
      expect(lastFrame()).toContain("Filter: _");
    });
  });

  // `d` used to open the delete prompt whenever a diverged row was selected,
  // so a filter could never contain the letter while one was.
  describe("deleting a diverged directory", () => {
    const renderStatusOnDiverged = async () => {
      const deleteDivergedDirectory = vi.fn().mockResolvedValue(undefined);
      const view = render(
        <WorktreeStatusView
          repositories={repositories.slice(0, 1)}
          getWorktreeStatusForRepo={vi.fn().mockResolvedValue([{ branch: "main", path: "/worktrees/main", status }])}
          getDivergedDirectoriesForRepo={vi.fn().mockResolvedValue([diverged])}
          deleteDivergedDirectory={deleteDivergedDirectory}
          onClose={vi.fn()}
        />,
      );
      await settle();
      view.stdin.write(DOWN);
      await settle();
      expect(view.lastFrame()).toContain("Ctrl-D to delete");
      return { ...view, deleteDivergedDirectory };
    };

    it("types d into the filter even with a diverged row selected", async () => {
      const { stdin, lastFrame, deleteDivergedDirectory } = await renderStatusOnDiverged();

      stdin.write("d");
      await settle();

      expect(lastFrame()).toContain("Filter: d");
      expect(lastFrame()).not.toContain("y/n");
      expect(deleteDivergedDirectory).not.toHaveBeenCalled();
    });

    it("asks before deleting on Ctrl-D and deletes on y", async () => {
      const { stdin, lastFrame, deleteDivergedDirectory } = await renderStatusOnDiverged();

      stdin.write(CTRL_D);
      await settle();
      expect(lastFrame()).toContain(`Delete ${diverged.name}? (y/n)`);

      stdin.write("y");
      await settle();
      expect(deleteDivergedDirectory).toHaveBeenCalledWith(0, diverged.name);
    });

    it("ignores Ctrl-D on a worktree row", async () => {
      const { stdin, lastFrame } = render(
        <WorktreeStatusView
          repositories={repositories.slice(0, 1)}
          getWorktreeStatusForRepo={vi.fn().mockResolvedValue([{ branch: "main", path: "/worktrees/main", status }])}
          getDivergedDirectoriesForRepo={vi.fn().mockResolvedValue([diverged])}
          deleteDivergedDirectory={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      await settle();

      stdin.write(CTRL_D);
      await settle();

      expect(lastFrame()).not.toContain("y/n");
      expect(lastFrame()).toContain("Filter: _");
    });
  });
});
