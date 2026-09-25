import React from "react";
import { render, cleanup } from "ink-testing-library";
import { describe, it, expect, vi, afterEach } from "vitest";

import ForceCleanModal from "../ForceCleanModal";

import type { ForceCleanPreview, ForceCleanRepositoryPreview, ForceCleanRepositoryResult } from "../../types";

const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 100));

// The purge needs the word typed and Enter, not a single key.
async function confirm(stdin: { write: (data: string) => void }): Promise<void> {
  stdin.write("clean");
  await settle();
  stdin.write("\r");
}

function preview(overrides: Partial<ForceCleanPreview> = {}): ForceCleanPreview {
  return {
    trashEntries: 2,
    trashBytes: 1024,
    unknownTrashSizes: 0,
    invalidTrashEntries: 0,
    keepRefs: 1,
    trashEntryIds: ["entry-a", "entry-b"],
    keepRefNames: ["refs/sync-worktrees/keep/ref-a"],
    ...overrides,
  };
}

function result(overrides: Partial<ForceCleanRepositoryResult["result"]> = {}): ForceCleanRepositoryResult {
  return {
    repoIndex: 0,
    repoName: "app",
    result: {
      ...preview({ trashEntries: 0, trashBytes: 0, keepRefs: 0, trashEntryIds: [], keepRefNames: [] }),
      trashDeleted: 2,
      keepRefsDeleted: 1,
      keepRefsRetained: 0,
      skippedNewEntries: 0,
      skippedNewKeepRefs: 0,
      gcSucceeded: true,
      gcSkipped: false,
      errors: [],
      ...overrides,
    },
  };
}

describe("ForceCleanModal", () => {
  afterEach(() => {
    cleanup();
  });

  // The modal is the consent record: the ids behind the counts it rendered are
  // what `y` authorizes, no matter how long the user takes to press it or what
  // a cron sync trashes in between.
  it("confirms with the ids it displayed, not the ones a later preview would return", async () => {
    const rows: ForceCleanRepositoryPreview[] = [{ repoIndex: 0, repoName: "app", preview: preview() }];
    const getPreview = vi.fn<() => Promise<ForceCleanRepositoryPreview[]>>().mockResolvedValue(rows);
    const forceClean = vi.fn().mockResolvedValue([result()]);
    const { stdin, lastFrame } = render(
      <ForceCleanModal getPreview={getPreview} forceClean={forceClean} onClose={vi.fn()} />,
    );

    await settle();
    expect(lastFrame()).toContain("2 trash");

    // A sync runs while the modal waits for a keypress and trashes another
    // worktree; every fresh look at the repo would now report three.
    getPreview.mockResolvedValue([
      {
        repoIndex: 0,
        repoName: "app",
        preview: preview({ trashEntries: 3, trashEntryIds: ["entry-a", "entry-b", "entry-c"] }),
      },
    ]);

    await confirm(stdin);
    await settle();

    expect(forceClean).toHaveBeenCalledWith([
      {
        repoIndex: 0,
        trashEntryIds: ["entry-a", "entry-b"],
        keepRefNames: ["refs/sync-worktrees/keep/ref-a"],
      },
    ]);
  });

  // A repo whose preview failed shows no counts, so it contributes no
  // selection — the service then has nothing to purge there.
  it("sends no selection for a repository whose preview failed", async () => {
    const forceClean = vi.fn().mockResolvedValue([]);
    const { stdin } = render(
      <ForceCleanModal
        getPreview={vi.fn().mockResolvedValue([
          { repoIndex: 0, repoName: "app", preview: preview() },
          { repoIndex: 1, repoName: "other", error: "not initialized" },
        ])}
        forceClean={forceClean}
        onClose={vi.fn()}
      />,
    );

    await settle();
    await confirm(stdin);
    await settle();

    expect(forceClean).toHaveBeenCalledWith([expect.objectContaining({ repoIndex: 0 })]);
  });

  it("reports what the purge left behind because it was not previewed", async () => {
    const { stdin, lastFrame } = render(
      <ForceCleanModal
        getPreview={vi.fn().mockResolvedValue([{ repoIndex: 0, repoName: "app", preview: preview() }])}
        forceClean={vi.fn().mockResolvedValue([result({ skippedNewEntries: 1, skippedNewKeepRefs: 2 })])}
        onClose={vi.fn()}
      />,
    );

    await settle();
    await confirm(stdin);
    await settle();

    // The box wraps at 78 columns, so match the phrase either side of the seam.
    expect(lastFrame()).toContain("left 1 trash and 2 ref(s)");
    expect(lastFrame()).toContain("added after this preview");
  });

  // "Active worktrees are not synced, changed, or removed" was true about the
  // files and false about the object store they all share, which is exactly
  // what the gc rewrites. The confirmation has to say which of the two it
  // means before it asks for a keypress.
  it("says the gc reaches the object store every worktree shares", async () => {
    const { lastFrame } = render(
      <ForceCleanModal
        getPreview={vi.fn().mockResolvedValue([{ repoIndex: 0, repoName: "app", preview: preview() }])}
        forceClean={vi.fn().mockResolvedValue([result()])}
        onClose={vi.fn()}
      />,
    );

    await settle();
    const frame = lastFrame() ?? "";
    // Wrapping at 78 columns puts line breaks mid-sentence, so match on words.
    expect(frame).toContain("object store");
    expect(frame).toContain("shares");
    expect(frame).toMatch(/worktree\s+files are not synced, changed, or removed/);
    expect(frame).not.toMatch(/worktrees are not synced, changed, or removed/);
  });

  // A single `y` sat right next to `n`, and a held key repeats: neither is a
  // decision to delete something irreversibly.
  it("does not purge on y, or on Enter before the word is typed", async () => {
    const forceClean = vi.fn().mockResolvedValue([result()]);
    const { stdin, lastFrame } = render(
      <ForceCleanModal
        getPreview={vi.fn().mockResolvedValue([{ repoIndex: 0, repoName: "app", preview: preview() }])}
        forceClean={forceClean}
        onClose={vi.fn()}
      />,
    );

    await settle();
    expect(lastFrame()).toContain("Type clean and press Enter");

    stdin.write("y");
    await settle();
    stdin.write("\r");
    await settle();
    expect(forceClean).not.toHaveBeenCalled();

    stdin.write("\u007F");
    await settle();
    stdin.write("clea");
    await settle();
    stdin.write("\r");
    await settle();
    expect(forceClean).not.toHaveBeenCalled();

    stdin.write("n");
    await settle();
    stdin.write("\r");
    await settle();
    expect(forceClean).toHaveBeenCalledTimes(1);
  });

  it("says there is nothing to clean instead of asking to delete nothing", async () => {
    const forceClean = vi.fn();
    const onClose = vi.fn();
    const { stdin, lastFrame } = render(
      <ForceCleanModal
        getPreview={vi.fn().mockResolvedValue([
          {
            repoIndex: 0,
            repoName: "app",
            preview: preview({ trashEntries: 0, trashBytes: 0, keepRefs: 0, trashEntryIds: [], keepRefNames: [] }),
          },
        ])}
        forceClean={forceClean}
        onClose={onClose}
      />,
    );

    await settle();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Nothing to clean");
    expect(frame).not.toContain("delete permanently");

    stdin.write("clean");
    await settle();
    expect(forceClean).not.toHaveBeenCalled();

    stdin.write("\r");
    await settle();
    expect(forceClean).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("reads a gc that was skipped as skipped, not as failed", async () => {
    const { stdin, lastFrame } = render(
      <ForceCleanModal
        getPreview={vi.fn().mockResolvedValue([{ repoIndex: 0, repoName: "app", preview: preview() }])}
        forceClean={vi.fn().mockResolvedValue([
          result({
            gcSucceeded: false,
            gcSkipped: true,
            errors: ["git gc skipped, git is busy in: /w/feature-1 (index.lock)"],
          }),
        ])}
        onClose={vi.fn()}
      />,
    );

    await settle();
    await confirm(stdin);
    await settle();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("GC skipped");
    expect(frame).not.toContain("GC failed");
    expect(frame).toContain("index.lock");
  });

  it("still reads a gc that ran and failed as failed", async () => {
    const { stdin, lastFrame } = render(
      <ForceCleanModal
        getPreview={vi.fn().mockResolvedValue([{ repoIndex: 0, repoName: "app", preview: preview() }])}
        forceClean={vi
          .fn()
          .mockResolvedValue([result({ gcSucceeded: false, gcSkipped: false, errors: ["git gc failed"] })])}
        onClose={vi.fn()}
      />,
    );

    await settle();
    await confirm(stdin);
    await settle();

    expect(lastFrame()).toContain("GC failed");
  });
});
