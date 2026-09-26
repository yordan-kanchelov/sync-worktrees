import React from "react";
import { render, cleanup } from "ink-testing-library";
import { describe, it, expect, vi, afterEach } from "vitest";

import BranchCreationWizard from "../BranchCreationWizard";
import ForceCleanModal from "../ForceCleanModal";
import HelpModal from "../HelpModal";
import OpenEditorWizard from "../OpenEditorWizard";
import WorktreeStatusView from "../WorktreeStatusView";
import {
  DASHBOARD_CHROME_ROWS,
  LOG_COLLAPSED_ROWS,
  LOG_MIN_ROWS,
  MIN_LIST_ROWS,
  dashboardColumns,
  formatAge,
  formatUntil,
  homeLayout,
  listRowsFor,
  listWindow,
  modalWidth,
  wrappedRows,
} from "../layout";
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

describe("home screen layout", () => {
  const auto = { collapsed: false, rows: null };

  it("gives the table every repository and the log the rest when there is room", () => {
    expect(homeLayout(19, 3, auto)).toEqual({ dashboardRows: 6, logRows: 13, logCollapsed: false });
    expect(homeLayout(45, 30, auto)).toEqual({ dashboardRows: 33, logRows: 12, logCollapsed: false });
  });

  it("leaves the log a readable panel when there are more repositories than rows", () => {
    const layout = homeLayout(19, 30, auto);

    expect(layout.dashboardRows + layout.logRows).toBe(19);
    expect(layout.logRows).toBeGreaterThanOrEqual(8);
    expect(layout.dashboardRows).toBeGreaterThan(DASHBOARD_CHROME_ROWS);
  });

  it("folds the log to one line when a panel and a table row do not both fit", () => {
    expect(homeLayout(7, 3, auto)).toEqual({ dashboardRows: 6, logRows: 1, logCollapsed: true });
    // Below an even split's first table row, the folded log still leaves one.
    expect(homeLayout(6, 3, auto)).toEqual({ dashboardRows: 5, logRows: 1, logCollapsed: true });
    expect(homeLayout(5, 1, auto)).toEqual({ dashboardRows: 4, logRows: 1, logCollapsed: true });
    expect(homeLayout(5, 3, auto)).toEqual({ dashboardRows: 4, logRows: 1, logCollapsed: true });
  });

  it("never takes the table away as the screen grows", () => {
    // The smallest screen a table row and a folded log both fit on.
    const smallest = DASHBOARD_CHROME_ROWS + 1 + LOG_COLLAPSED_ROWS;
    for (const repos of [1, 2, 3, 30]) {
      for (const preference of [auto, { collapsed: true, rows: null }, { collapsed: false, rows: LOG_MIN_ROWS }]) {
        let shown = false;
        for (let available = 0; available <= 40; available++) {
          const visible = homeLayout(available, repos, preference).dashboardRows > 0;
          const expected = shown || visible || (preference.rows === null && available >= smallest);
          expect({ available, repos, preference, visible }).toEqual({
            available,
            repos,
            preference,
            visible: expected,
          });
          shown ||= visible;
        }
      }
    }
  });

  it("hides the table rather than draw it without a single row", () => {
    expect(homeLayout(4, 3, auto)).toEqual({ dashboardRows: 0, logRows: 4, logCollapsed: false });
    expect(homeLayout(19, 0, auto)).toEqual({ dashboardRows: 0, logRows: 19, logCollapsed: false });
  });

  it("collapses the log to one line on request and hands the table the room", () => {
    expect(homeLayout(19, 30, { collapsed: true, rows: null })).toEqual({
      dashboardRows: 18,
      logRows: 1,
      logCollapsed: true,
    });
  });

  it("gives the log the rows asked for, down to hiding the table", () => {
    expect(homeLayout(19, 30, { collapsed: false, rows: 6 })).toEqual({
      dashboardRows: 13,
      logRows: 6,
      logCollapsed: false,
    });
    expect(homeLayout(19, 30, { collapsed: false, rows: 17 })).toEqual({
      dashboardRows: 0,
      logRows: 19,
      logCollapsed: false,
    });
    // A request below the smallest panel still leaves one.
    expect(homeLayout(19, 30, { collapsed: false, rows: 1 }).logRows).toBeGreaterThanOrEqual(1);
  });

  it("never hands out more rows than it was given", () => {
    for (let available = 0; available <= 40; available++) {
      for (const repos of [0, 1, 3, 30]) {
        for (const preference of [auto, { collapsed: true, rows: null }, { collapsed: false, rows: LOG_MIN_ROWS }]) {
          const layout = homeLayout(available, repos, preference);
          expect(layout.dashboardRows + layout.logRows).toBeLessThanOrEqual(Math.max(1, available));
        }
      }
    }
  });

  it("drops columns in order as the table narrows, keeping the state and the name", () => {
    expect(dashboardColumns(96, 12).columns).toEqual([
      "state",
      "name",
      "result",
      "age",
      "worktrees",
      "changes",
      "next",
    ]);
    expect(dashboardColumns(56, 12).columns).not.toContain("next");
    expect(dashboardColumns(36, 12).columns).toEqual(["state", "name", "result"]);
    expect(dashboardColumns(20, 12).columns).toEqual(["state", "name"]);
  });

  it("fits the columns and the spaces between them into the width", () => {
    for (let width = 12; width <= 140; width++) {
      const { columns, widths } = dashboardColumns(width, 40);
      const used = columns.reduce((sum, column) => sum + widths[column], 0) + columns.length - 1;
      expect(used).toBeLessThanOrEqual(Math.max(width, 20));
    }
  });

  it("says how long ago and how long until in a few characters", () => {
    const now = 1_000_000_000;
    expect(formatAge(now - 5_000, now)).toBe("just now");
    expect(formatAge(now - 3 * 60_000, now)).toBe("3m ago");
    expect(formatAge(now - 5 * 3_600_000, now)).toBe("5h ago");
    expect(formatAge(now - 72 * 3_600_000, now)).toBe("3d ago");
    expect(formatUntil(now + 30_000, now)).toBe("<1m");
    expect(formatUntil(now + 14 * 60_000, now)).toBe("14m");
    expect(formatUntil(now + 3 * 3_600_000, now)).toBe("3h");
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

  describe("force-clean modal height", () => {
    const previews = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        repoIndex: index,
        repoName: `repository-${String(index).padStart(2, "0")}`,
        preview: {
          trashEntries: 2,
          trashBytes: 1024,
          unknownTrashSizes: 0,
          invalidTrashEntries: 0,
          keepRefs: 1,
          trashEntryIds: ["a", "b"],
          keepRefNames: ["refs/sync-worktrees/keep/a"],
        },
      }));
    const listed = (frame: string | undefined): string[] =>
      frameLines(frame)
        .map((line) => line.match(/(repository-\d+):/)?.[1])
        .filter((name): name is string => name !== undefined);

    it("caps the per-repository list to the rows the status bar leaves", async () => {
      const { stdout, lastFrame } = render(
        <ForceCleanModal
          availableRows={19}
          getPreview={vi.fn().mockResolvedValue(previews(12))}
          forceClean={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      resizeTerminal(stdout, 80, 24);
      await settle();

      expect(frameLines(lastFrame()).length).toBeLessThanOrEqual(19);
      expect(listed(lastFrame()).length).toBeGreaterThan(0);
      expect(listed(lastFrame()).length).toBeLessThan(12);
      expect(lastFrame()).toMatch(/repositories 1–\d+ of 12 \(↑\/↓ to scroll\)/);
      // The total and the confirmation are never what gives way.
      expect(lastFrame()).toContain("Total: 24 trash");
      expect(lastFrame()).toContain("press Enter to delete permanently");
    });

    it("scrolls the list with the arrows and leaves the confirmation word alone", async () => {
      const forceClean = vi.fn().mockResolvedValue([]);
      const { stdout, stdin, lastFrame } = render(
        <ForceCleanModal
          availableRows={19}
          getPreview={vi.fn().mockResolvedValue(previews(12))}
          forceClean={forceClean}
          onClose={vi.fn()}
        />,
      );
      resizeTerminal(stdout, 80, 24);
      await settle();
      const first = listed(lastFrame())[0];

      for (let i = 0; i < 20; i++) {
        stdin.write("\u001B[B");
      }
      await settle();

      expect(listed(lastFrame())).toContain("repository-11");
      expect(listed(lastFrame())).not.toContain(first);
      expect(frameLines(lastFrame()).length).toBeLessThanOrEqual(19);

      stdin.write("clean");
      await settle();
      stdin.write("\r");
      await settle();
      expect(forceClean).toHaveBeenCalledTimes(1);
      expect(forceClean.mock.calls[0][0]).toHaveLength(12);
    });

    it("shortens its explanation before squeezing the list in a short terminal", async () => {
      const { stdout, lastFrame } = render(
        <ForceCleanModal
          availableRows={14}
          getPreview={vi.fn().mockResolvedValue(previews(5))}
          forceClean={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      resizeTerminal(stdout, 80, 19);
      await settle();

      expect(frameLines(lastFrame()).length).toBeLessThanOrEqual(14);
      expect(lastFrame()).not.toContain("A lock left behind");
      expect(lastFrame()).toContain("finish any git command");
      expect(listed(lastFrame()).length).toBeGreaterThanOrEqual(3);
    });

    it("shows the whole explanation and every repository when there is room", async () => {
      const { stdout, lastFrame } = render(
        <ForceCleanModal
          availableRows={40}
          getPreview={vi.fn().mockResolvedValue(previews(5))}
          forceClean={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      resizeTerminal(stdout, 100, 45);
      await settle();

      expect(lastFrame()).toContain("A lock left behind");
      expect(listed(lastFrame())).toHaveLength(5);
      expect(lastFrame()).not.toContain("to scroll");
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
