import React from "react";
import { render, cleanup } from "ink-testing-library";
import { describe, it, expect, vi, afterEach } from "vitest";

import BranchCreationWizard from "../BranchCreationWizard";
import ForceCleanModal from "../ForceCleanModal";
import HelpModal from "../HelpModal";
import OpenEditorWizard from "../OpenEditorWizard";
import WorktreeStatusView from "../WorktreeStatusView";
import { MIN_LIST_ROWS, listRowsFor, listWindow, modalWidth, wrappedRows } from "../layout";
import type { WorktreeStatusResult } from "../../services/worktree-status.service";
import type { WorktreeStatusEntry } from "../../types";
import { borderWidths, frameLines, resizeTerminal } from "./terminal-size";

const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 100));

const repos = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    index,
    name: `repository-${String(index).padStart(2, "0")}`,
    repoUrl: `https://example.com/repository-${index}.git`,
  }));

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

const entries = (count: number): WorktreeStatusEntry[] =>
  Array.from({ length: count }, (_, index) => ({
    branch: `branch-${String(index).padStart(2, "0")}`,
    path: `/worktrees/branch-${index}`,
    status,
  }));

/** Items of a rendered list: rows that start with the selection marker or its indent. */
const listedNames = (frame: string | undefined, prefix: string): string[] =>
  frameLines(frame)
    .map((line) => line.match(new RegExp(`(?:> |  )(${prefix}-\\d+)`))?.[1])
    .filter((name): name is string => name !== undefined);

describe("layout helpers", () => {
  it("never makes a modal wider than the terminal leaves room for", () => {
    expect(modalWidth(70, 120)).toBe(70);
    expect(modalWidth(70, 50)).toBe(48);
    // Below the floor nothing inside is legible; the floor wins.
    expect(modalWidth(70, 10)).toBe(24);
  });

  it("shows a list whole when it fits and reserves the `...` rows when it does not", () => {
    expect(listRowsFor(10, 4)).toBe(4);
    expect(listRowsFor(10, 10)).toBe(10);
    expect(listRowsFor(10, 11)).toBe(8);
    expect(listRowsFor(40, 100)).toBe(38);
    expect(listRowsFor(2, 100)).toBe(MIN_LIST_ROWS);
    expect(listRowsFor(-5, 100)).toBe(MIN_LIST_ROWS);
    // "No matches" still takes a row.
    expect(listRowsFor(10, 0)).toBe(1);
  });

  it("keeps the selection inside the window at both ends of the list", () => {
    expect(listWindow(0, 20, 5)).toEqual({ start: 0, end: 5 });
    expect(listWindow(10, 20, 5)).toEqual({ start: 8, end: 13 });
    expect(listWindow(19, 20, 5)).toEqual({ start: 15, end: 20 });
    expect(listWindow(2, 3, 5)).toEqual({ start: 0, end: 3 });
  });

  it("counts the rows Ink word-wraps a line into", () => {
    expect(wrappedRows("short", 20)).toBe(1);
    expect(wrappedRows("one two three four", 13)).toBe(2);
    expect(wrappedRows("one two three four", 9)).toBe(3);
    expect(wrappedRows("↑/↓ navigate • Type to filter • Enter to select • ESC to cancel", 54)).toBe(2);
    // A word longer than the line is broken across rows.
    expect(wrappedRows("x".repeat(25), 10)).toBe(3);
  });
});

describe("responsive modals", () => {
  afterEach(() => {
    cleanup();
  });

  describe("narrow terminals", () => {
    it("fits the worktree status view inside a 50-column terminal", async () => {
      const { stdout, lastFrame } = render(
        <WorktreeStatusView
          repositories={repos(1)}
          getWorktreeStatusForRepo={vi.fn().mockResolvedValue(entries(3))}
          onClose={vi.fn()}
        />,
      );
      resizeTerminal(stdout, 50, 40);
      await settle();

      expect(borderWidths(lastFrame())).toEqual([48]);
      // The right-hand border is drawn, not clipped at the terminal edge.
      expect(
        frameLines(lastFrame())
          .find((line) => line.includes("╭"))
          ?.trimEnd(),
      ).toMatch(/╮$/);
      expect(lastFrame()).toContain("branch-00");
    });

    it("fits the wizards inside a 40-column terminal", async () => {
      const wizard = render(
        <OpenEditorWizard
          repositories={repos(3)}
          getWorktreesForRepo={vi.fn().mockResolvedValue([])}
          openEditorInWorktree={vi.fn()}
          openTerminalInWorktree={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      resizeTerminal(wizard.stdout, 40, 40);
      await settle();
      expect(borderWidths(wizard.lastFrame())).toEqual([38]);

      const branch = render(
        <BranchCreationWizard
          repositories={repos(3)}
          getBranchesForRepo={vi.fn().mockResolvedValue([])}
          getDefaultBranchForRepo={vi.fn().mockResolvedValue("main")}
          createAndPushBranch={vi.fn()}
          onClose={vi.fn()}
          onComplete={vi.fn()}
        />,
      );
      resizeTerminal(branch.stdout, 40, 40);
      await settle();
      expect(borderWidths(branch.lastFrame())).toEqual([38]);
    });

    it("fits the force-clean modal inside a 60-column terminal", async () => {
      const { stdout, lastFrame } = render(
        <ForceCleanModal getPreview={vi.fn().mockResolvedValue([])} forceClean={vi.fn()} onClose={vi.fn()} />,
      );
      resizeTerminal(stdout, 60, 40);
      await settle();

      expect(borderWidths(lastFrame())).toEqual([58]);
    });

    it("keeps its preferred width when the terminal is wide", async () => {
      const { stdout, lastFrame } = render(
        <ForceCleanModal getPreview={vi.fn().mockResolvedValue([])} forceClean={vi.fn()} onClose={vi.fn()} />,
      );
      resizeTerminal(stdout, 160, 40);
      await settle();

      expect(borderWidths(lastFrame())).toEqual([78]);
    });

    it("truncates help rows instead of wrapping them in a narrow terminal", async () => {
      const { stdout, lastFrame } = render(<HelpModal onClose={vi.fn()} />);
      resizeTerminal(stdout, 40, 60);
      await settle();

      expect(borderWidths(lastFrame())).toEqual([38]);
      // One row per shortcut: a wrapped description would have split this one.
      const syncRow = frameLines(lastFrame()).find((line) => line.includes("Manually trigg"));
      expect(syncRow).toBeDefined();
      expect(frameLines(lastFrame()).filter((line) => line.includes("repositories"))).toHaveLength(0);
    });
  });

  describe("list rows follow the terminal height", () => {
    it("shows more than eight repositories in a tall terminal", async () => {
      const { stdout, lastFrame } = render(
        <OpenEditorWizard
          repositories={repos(30)}
          getWorktreesForRepo={vi.fn().mockResolvedValue([])}
          openEditorInWorktree={vi.fn()}
          openTerminalInWorktree={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      resizeTerminal(stdout, 100, 50);
      await settle();

      const shown = listedNames(lastFrame(), "repository");
      expect(shown.length).toBeGreaterThan(8);
      expect(frameLines(lastFrame()).length).toBeLessThanOrEqual(50);
    });

    it("shrinks the list so the modal fits a short terminal", async () => {
      const { stdout, lastFrame } = render(
        <BranchCreationWizard
          repositories={repos(30)}
          getBranchesForRepo={vi.fn().mockResolvedValue([])}
          getDefaultBranchForRepo={vi.fn().mockResolvedValue("main")}
          createAndPushBranch={vi.fn()}
          onClose={vi.fn()}
          onComplete={vi.fn()}
        />,
      );
      resizeTerminal(stdout, 100, 20);
      await settle();

      expect(listedNames(lastFrame(), "repository").length).toBeLessThan(8);
      expect(frameLines(lastFrame()).length).toBeLessThanOrEqual(20);
    });

    it("sizes the status list to the rows the caller has left", async () => {
      const { lastFrame } = render(
        <WorktreeStatusView
          repositories={repos(1)}
          getWorktreeStatusForRepo={vi.fn().mockResolvedValue(entries(40))}
          onClose={vi.fn()}
          availableRows={30}
        />,
      );
      await settle();

      expect(listedNames(lastFrame(), "branch").length).toBeGreaterThan(8);
      expect(frameLines(lastFrame()).length).toBeLessThanOrEqual(30);
    });

    it("keeps the status view inside its rows with an entry expanded", async () => {
      const { stdin, lastFrame } = render(
        <WorktreeStatusView
          repositories={repos(1)}
          getWorktreeStatusForRepo={vi.fn().mockResolvedValue(entries(40))}
          onClose={vi.fn()}
          availableRows={30}
        />,
      );
      await settle();
      stdin.write("\r");
      await settle();

      expect(lastFrame()).toContain("Path: /worktrees/branch-0");
      expect(frameLines(lastFrame()).length).toBeLessThanOrEqual(30);
    });
  });

  describe("help screen", () => {
    it("fits a short terminal and scrolls to the rows it could not show", async () => {
      const { stdout, stdin, lastFrame } = render(<HelpModal onClose={vi.fn()} availableRows={16} />);
      resizeTerminal(stdout, 100, 16);
      await settle();

      expect(frameLines(lastFrame()).length).toBeLessThanOrEqual(16);
      expect(lastFrame()).toContain("more");
      expect(lastFrame()).not.toContain("Gracefully quit");

      for (let i = 0; i < 20; i++) {
        stdin.write("j");
      }
      await settle();

      expect(lastFrame()).toContain("Gracefully quit");
      expect(lastFrame()).toContain("Ctrl-D");
      expect(frameLines(lastFrame()).length).toBeLessThanOrEqual(16);
    });

    it("shows the whole sheet without scrolling when there is room", async () => {
      const { stdout, lastFrame } = render(<HelpModal onClose={vi.fn()} />);
      resizeTerminal(stdout, 100, 60);
      await settle();

      expect(lastFrame()).toContain("Scroll down one line");
      expect(lastFrame()).toContain("Gracefully quit");
      expect(lastFrame()).not.toContain("↑/↓ scroll");
    });
  });
});
