import React from "react";
import { render, cleanup } from "ink-testing-library";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { FuzzySwitcherProps } from "../FuzzySwitcher";
import FuzzySwitcher from "../FuzzySwitcher";
import { borderWidths, frameLines, resizeTerminal } from "./terminal-size";

const waitForStateUpdate = () => new Promise((resolve) => setTimeout(resolve, 50));

const ESC = "\u001B";
const DOWN = "\u001B[B";
const TAB = "\t";
const ENTER = "\r";
const CTRL_N = "\u000E";
const CTRL_P = "\u0010";
const CTRL_U = "\u0015";

const WORKTREES: Record<number, Array<{ path: string; branch: string }>> = {
  0: [
    { path: "/w/api/main", branch: "main" },
    { path: "/w/api/feature-login", branch: "feature/login" },
  ],
  1: [
    { path: "/w/web/main", branch: "main" },
    { path: "/w/web/fix-header", branch: "fix/header" },
  ],
};

const selectedLine = (frame: string | undefined): string | undefined =>
  frameLines(frame).find((line) => line.includes("> ") && line.includes("›"));

describe("FuzzySwitcher", () => {
  let props: FuzzySwitcherProps;

  beforeEach(() => {
    props = {
      repositories: [
        { index: 0, name: "api", repoUrl: "https://example.com/api.git" },
        { index: 1, name: "web", repoUrl: "https://example.com/web.git" },
      ],
      getWorktreesForRepo: vi.fn((index: number) => Promise.resolve(WORKTREES[index] ?? [])),
      openEditorInWorktree: vi.fn().mockReturnValue({ success: true }),
      openTerminalInWorktree: vi.fn().mockReturnValue({ success: true }),
      copyToClipboard: vi.fn().mockResolvedValue({ success: true }),
      syncRepository: vi.fn().mockReturnValue(null),
      showStatus: vi.fn(),
      notify: vi.fn(),
      onClose: vi.fn(),
    };
  });

  afterEach(() => {
    cleanup();
  });

  it("lists every worktree across repositories as `repo › branch`", async () => {
    const { lastFrame } = render(<FuzzySwitcher {...props} />);
    await waitForStateUpdate();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Go to worktree");
    for (const label of ["api › main", "api › feature/login", "web › main", "web › fix/header"]) {
      expect(frame).toContain(label);
    }
    expect(frame).toContain("4/4");
    expect(props.getWorktreesForRepo).toHaveBeenCalledTimes(2);
  });

  it("filters and ranks as you type", async () => {
    const { stdin, lastFrame } = render(<FuzzySwitcher {...props} />);
    await waitForStateUpdate();

    stdin.write("wm");
    await waitForStateUpdate();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("1/4");
    expect(selectedLine(frame)).toContain("web › main");
    expect(frame).not.toContain("api › feature/login");
    // The selected entry's path is shown under the list.
    expect(frame).toContain("/w/web/main");
  });

  it("says so when nothing matches, and Ctrl-U clears the filter", async () => {
    const { stdin, lastFrame } = render(<FuzzySwitcher {...props} />);
    await waitForStateUpdate();

    stdin.write("zzz");
    await waitForStateUpdate();
    expect(lastFrame()).toContain("No matches");

    stdin.write(CTRL_U);
    await waitForStateUpdate();
    expect(lastFrame()).toContain("4/4");
  });

  it("moves with ↓ and Ctrl-N / Ctrl-P, and Enter opens the selection in the editor", async () => {
    const { stdin, lastFrame } = render(<FuzzySwitcher {...props} />);
    await waitForStateUpdate();

    stdin.write(DOWN);
    await waitForStateUpdate();
    stdin.write(CTRL_N);
    await waitForStateUpdate();
    expect(selectedLine(lastFrame())).toContain("web › main");

    stdin.write(CTRL_P);
    await waitForStateUpdate();
    expect(selectedLine(lastFrame())).toContain("api › feature/login");

    stdin.write(ENTER);
    await waitForStateUpdate();
    expect(props.openEditorInWorktree).toHaveBeenCalledWith("/w/api/feature-login");
    expect(props.onClose).toHaveBeenCalled();
  });

  it("keeps a failed launch on screen instead of closing", async () => {
    props.openEditorInWorktree = vi.fn().mockReturnValue({ success: false, error: "'vim' is a terminal editor" });
    const { stdin, lastFrame } = render(<FuzzySwitcher {...props} />);
    await waitForStateUpdate();

    stdin.write(ENTER);
    await waitForStateUpdate();

    expect(lastFrame()).toContain("'vim' is a terminal editor");
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("types action letters into the filter rather than acting on them", async () => {
    const { stdin, lastFrame } = render(<FuzzySwitcher {...props} />);
    await waitForStateUpdate();

    stdin.write("t");
    await waitForStateUpdate();

    expect(props.openTerminalInWorktree).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("> t");
  });

  describe("actions menu (Tab)", () => {
    const openMenuOn = async (query: string) => {
      const rendered = render(<FuzzySwitcher {...props} />);
      await waitForStateUpdate();
      rendered.stdin.write(query);
      await waitForStateUpdate();
      rendered.stdin.write(TAB);
      await waitForStateUpdate();
      return rendered;
    };

    it("lists the actions for the selected worktree", async () => {
      const { lastFrame } = await openMenuOn("web fix");
      const frame = lastFrame() ?? "";
      expect(frame).toContain("web › fix/header");
      expect(frame).toContain("/w/web/fix-header");
      for (const label of ["Open in editor", "Open terminal", "Copy path", "Sync this repository", "Show status"]) {
        expect(frame).toContain(label);
      }
    });

    it("`t` opens a terminal in the worktree", async () => {
      const { stdin } = await openMenuOn("web fix");
      stdin.write("t");
      await waitForStateUpdate();
      expect(props.openTerminalInWorktree).toHaveBeenCalledWith(1, "/w/web/fix-header", "fix/header");
      expect(props.onClose).toHaveBeenCalled();
    });

    it("`e` opens the editor", async () => {
      const { stdin } = await openMenuOn("api login");
      stdin.write("e");
      await waitForStateUpdate();
      expect(props.openEditorInWorktree).toHaveBeenCalledWith("/w/api/feature-login");
    });

    it("`y` copies the path and confirms through the App", async () => {
      const { stdin } = await openMenuOn("web fix");
      stdin.write("y");
      await waitForStateUpdate();
      expect(props.copyToClipboard).toHaveBeenCalledWith("/w/web/fix-header");
      expect(props.notify).toHaveBeenCalledWith("Copied /w/web/fix-header");
      expect(props.onClose).toHaveBeenCalled();
    });

    it("`y` without a clipboard tool says why and shows the path", async () => {
      props.copyToClipboard = vi.fn().mockResolvedValue({ success: false, error: "No clipboard tool found" });
      const { stdin, lastFrame } = await openMenuOn("web fix");
      stdin.write("y");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("No clipboard tool found — path: /w/web/fix-header");
      expect(props.onClose).not.toHaveBeenCalled();
    });

    it("`s` syncs only that repository", async () => {
      const { stdin } = await openMenuOn("web fix");
      stdin.write("s");
      await waitForStateUpdate();
      expect(props.syncRepository).toHaveBeenCalledWith(1);
      expect(props.notify).toHaveBeenCalledWith("Syncing web…");
      expect(props.onClose).toHaveBeenCalled();
    });

    it("`s` shows why a sync could not start", async () => {
      props.syncRepository = vi.fn().mockReturnValue("A sync is in progress; try again when it finishes.");
      const { stdin, lastFrame } = await openMenuOn("web fix");
      stdin.write("s");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("A sync is in progress");
      expect(props.onClose).not.toHaveBeenCalled();
    });

    it("`w` hands over to the status view for that worktree", async () => {
      const { stdin } = await openMenuOn("api login");
      stdin.write("w");
      await waitForStateUpdate();
      expect(props.showStatus).toHaveBeenCalledWith(0, "feature/login");
    });

    it("leaves out actions the App did not provide", async () => {
      props.copyToClipboard = undefined;
      props.syncRepository = undefined;
      props.showStatus = undefined;
      const { stdin, lastFrame } = await openMenuOn("web fix");
      expect(lastFrame()).not.toContain("Copy path");
      stdin.write("s");
      await waitForStateUpdate();
      expect(props.onClose).not.toHaveBeenCalled();
    });

    it("Esc goes back to the list with the filter kept", async () => {
      const { stdin, lastFrame } = await openMenuOn("web fix");
      stdin.write(ESC);
      await waitForStateUpdate();
      expect(lastFrame()).toContain("> web fix");
      expect(props.onClose).not.toHaveBeenCalled();
    });
  });

  it("Esc closes from the list", async () => {
    const { stdin } = render(<FuzzySwitcher {...props} />);
    await waitForStateUpdate();
    stdin.write(ESC);
    await waitForStateUpdate();
    expect(props.onClose).toHaveBeenCalled();
  });

  it("lists what loaded and names a repository that could not be listed", async () => {
    props.getWorktreesForRepo = vi.fn((index: number) =>
      index === 1 ? Promise.reject(new Error("not a git repository")) : Promise.resolve(WORKTREES[index]),
    );
    const { lastFrame } = render(<FuzzySwitcher {...props} />);
    await waitForStateUpdate();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("api › main");
    expect(frame).toContain("Could not list web: not a git repository");
  });

  it("keeps the selection on the same entry while other repositories are still loading", async () => {
    let resolveWeb: (value: Array<{ path: string; branch: string }>) => void = () => undefined;
    props.repositories = [
      { index: 1, name: "web", repoUrl: "" },
      { index: 0, name: "api", repoUrl: "" },
    ];
    props.getWorktreesForRepo = vi.fn((index: number) =>
      index === 1
        ? new Promise<Array<{ path: string; branch: string }>>((resolve) => {
            resolveWeb = resolve;
          })
        : Promise.resolve(WORKTREES[0]),
    );
    const { stdin, lastFrame } = render(<FuzzySwitcher {...props} />);
    await waitForStateUpdate();
    expect(lastFrame()).toContain("loading 1/2 repositories");

    stdin.write(DOWN);
    await waitForStateUpdate();
    expect(selectedLine(lastFrame())).toContain("api › feature/login");

    // web is listed first, so its rows land above the selection.
    resolveWeb(WORKTREES[1]);
    await waitForStateUpdate();
    expect(selectedLine(lastFrame())).toContain("api › feature/login");

    stdin.write(ENTER);
    await waitForStateUpdate();
    expect(props.openEditorInWorktree).toHaveBeenCalledWith("/w/api/feature-login");
  });

  it("fits a small terminal: never wider than the window, never taller than its rows", async () => {
    props.repositories = [{ index: 0, name: "big", repoUrl: "" }];
    props.getWorktreesForRepo = vi
      .fn()
      .mockResolvedValue(Array.from({ length: 50 }, (_, i) => ({ path: `/w/big/b${i}`, branch: `branch-${i}` })));
    const { stdout, lastFrame } = render(<FuzzySwitcher {...props} availableRows={16} />);
    resizeTerminal(stdout, 40, 16);
    await waitForStateUpdate();

    const frame = lastFrame();
    expect(frameLines(frame).length).toBeLessThanOrEqual(16);
    for (const width of borderWidths(frame)) expect(width).toBeLessThanOrEqual(40);
    expect(frame).toContain("more");
  });
});
