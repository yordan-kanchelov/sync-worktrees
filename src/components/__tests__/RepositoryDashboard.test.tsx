import React from "react";
import { render, cleanup } from "ink-testing-library";
import { describe, it, expect, afterEach, vi } from "vitest";

import RepositoryDashboard from "../RepositoryDashboard";
import { borderWidths, frameLines, resizeTerminal } from "./terminal-size";

import type { RepositoryDashboardRow } from "../../utils/app-events";

const settle = (ms = 100): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, ms));

const MINUTE = 60_000;

function rows(now: number): RepositoryDashboardRow[] {
  return [
    {
      name: "frontend",
      state: "idle",
      lastResult: "2 created, 1 removed",
      lastSyncAt: now - 3 * MINUTE,
      worktrees: 12,
      changes: { dirty: 2, unpushed: 1 },
      schedule: "*/15 * * * *",
    },
    {
      name: "backend",
      state: "syncing",
      lastResult: "up to date",
      lastSyncAt: now - 3 * 60 * MINUTE,
      worktrees: 4,
      changes: { dirty: 0, unpushed: 0 },
      schedule: "0 * * * *",
    },
    {
      name: "infra",
      state: "failed",
      lastResult: "fatal: could not read from remote repository",
      lastSyncAt: now - 10_000,
      worktrees: null,
      changes: null,
    },
    {
      name: "docs",
      state: "skipped",
      lastResult: "locked by another process",
      lastSyncAt: null,
      worktrees: 1,
      changes: null,
    },
  ];
}

const rowOf = (frame: string | undefined, name: string): string =>
  frameLines(frame).find((line) => line.includes(name)) ?? "";

describe("RepositoryDashboard", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows one row per repository with its state as an icon and a word", async () => {
    const { stdout, lastFrame } = render(<RepositoryDashboard rows={rows(Date.now())} height={10} />);
    resizeTerminal(stdout, 120, 30);
    await settle();

    expect(rowOf(lastFrame(), "frontend")).toContain("● idle");
    expect(rowOf(lastFrame(), "backend")).toContain("⟳ syncing");
    expect(rowOf(lastFrame(), "infra")).toContain("✗ failed");
    expect(rowOf(lastFrame(), "docs")).toContain("⚠ skipped");
  });

  it("shows the last result, its age, the worktrees, the changes and the next run", async () => {
    const { stdout, lastFrame } = render(<RepositoryDashboard rows={rows(Date.now())} height={10} />);
    resizeTerminal(stdout, 120, 30);
    await settle();

    const heading = frameLines(lastFrame())[1];
    for (const column of ["STATE", "REPOSITORY", "LAST RESULT", "SYNCED", "WT", "CHANGES", "NEXT"]) {
      expect(heading).toContain(column);
    }
    const frontend = rowOf(lastFrame(), "frontend");
    expect(frontend).toContain("2 created, 1 removed");
    expect(frontend).toContain("3m ago");
    expect(frontend).toContain("12");
    expect(frontend).toContain("M2 ↑1");
    expect(frontend).toMatch(/\b\d+m\s/);
    // Clean and pushed everywhere; never checked; never synced; no schedule.
    expect(rowOf(lastFrame(), "backend")).toContain("✓");
    expect(rowOf(lastFrame(), "backend")).toContain("3h ago");
    expect(rowOf(lastFrame(), "infra")).toContain("just now");
    expect(rowOf(lastFrame(), "docs")).toMatch(/process\s+–/);
  });

  it("ages the last sync as time passes, without a new event", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-01-01T12:00:00Z").getTime();
    vi.setSystemTime(start);
    const { stdout, lastFrame } = render(<RepositoryDashboard rows={rows(start)} height={10} refreshMs={20} />);
    resizeTerminal(stdout, 120, 30);
    await settle();
    expect(rowOf(lastFrame(), "frontend")).toContain("3m ago");

    vi.setSystemTime(start + 10 * MINUTE);
    await settle();

    expect(rowOf(lastFrame(), "frontend")).toContain("13m ago");
    expect(rowOf(lastFrame(), "infra")).toContain("10m ago");
  });

  it("counts the repositories it has no room for, and names the ones that need a look", async () => {
    const { stdout, lastFrame } = render(<RepositoryDashboard rows={rows(Date.now())} height={5} />);
    resizeTerminal(stdout, 120, 30);
    await settle();

    expect(frameLines(lastFrame())).toHaveLength(5);
    expect(lastFrame()).toContain("frontend");
    expect(lastFrame()).not.toContain("backend");
    expect(lastFrame()).toContain("… 3 more, 1 failed, 1 syncing");
  });

  describe("narrow terminals", () => {
    it.each([80, 60, 40, 30])("keeps every row on one line inside %i columns", async (columns) => {
      const { stdout, lastFrame } = render(<RepositoryDashboard rows={rows(Date.now())} height={7} />);
      resizeTerminal(stdout, columns, 30);
      await settle();

      const lines = frameLines(lastFrame());
      expect(lines).toHaveLength(7);
      expect(borderWidths(lastFrame())).toEqual([columns]);
      for (const line of lines) {
        expect([...line].length).toBeLessThanOrEqual(columns);
      }
      // The state and the name are the last to go.
      expect(rowOf(lastFrame(), "front")).toContain("idle");
    });

    it("drops the next run first and the result last", async () => {
      const { stdout, lastFrame } = render(<RepositoryDashboard rows={rows(Date.now())} height={7} />);

      resizeTerminal(stdout, 60, 30);
      await settle();
      expect(frameLines(lastFrame())[1]).not.toContain("NEXT");
      expect(frameLines(lastFrame())[1]).toContain("LAST RESULT");

      resizeTerminal(stdout, 40, 30);
      await settle();
      expect(frameLines(lastFrame())[1]).not.toContain("SYNCED");
      expect(frameLines(lastFrame())[1]).toContain("LAST RESULT");
    });
  });
});
