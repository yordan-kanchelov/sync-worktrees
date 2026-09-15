import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { symlinksSupported } from "../../__tests__/helpers/symlink-support";

import { formatGitBusySignals, probeInFlightGitOperations } from "../git-busy-probe";

describe("probeInFlightGitOperations", () => {
  let gitDir: string;

  beforeEach(async () => {
    gitDir = await fs.mkdtemp(path.join(os.tmpdir(), "swt-busy-probe-"));
  });

  afterEach(async () => {
    await fs.rm(gitDir, { recursive: true, force: true });
  });

  async function registerWorktree(name: string, checkoutPath: string): Promise<string> {
    const adminDir = path.join(gitDir, "worktrees", name);
    await fs.mkdir(adminDir, { recursive: true });
    await fs.writeFile(path.join(adminDir, "gitdir"), `${path.join(checkoutPath, ".git")}\n`);
    return adminDir;
  }

  it("reports nothing for a git dir with no linked worktrees", async () => {
    await expect(probeInFlightGitOperations(gitDir)).resolves.toEqual([]);
  });

  it("reports nothing when registered worktrees are idle", async () => {
    await registerWorktree("feature-a", "/checkouts/feature-a");
    await registerWorktree("feature-b", "/checkouts/feature-b");

    await expect(probeInFlightGitOperations(gitDir)).resolves.toEqual([]);
  });

  it("reports a worktree holding index.lock, named by its checkout path", async () => {
    await registerWorktree("idle", "/checkouts/idle");
    const busy = await registerWorktree("feature-a", "/checkouts/feature-a");
    await fs.writeFile(path.join(busy, "index.lock"), "");

    await expect(probeInFlightGitOperations(gitDir)).resolves.toEqual([
      { worktree: path.join("/checkouts", "feature-a"), marker: "index.lock" },
    ]);
  });

  it.each([
    ["MERGE_HEAD", "file"],
    ["CHERRY_PICK_HEAD", "file"],
    ["REVERT_HEAD", "file"],
    ["BISECT_LOG", "file"],
    ["rebase-merge", "dir"],
    ["rebase-apply", "dir"],
  ])("reports an unfinished operation left behind as %s", async (marker, kind) => {
    const admin = await registerWorktree("feature-a", "/checkouts/feature-a");
    if (kind === "dir") {
      await fs.mkdir(path.join(admin, marker));
    } else {
      await fs.writeFile(path.join(admin, marker), "");
    }

    await expect(probeInFlightGitOperations(gitDir)).resolves.toEqual([
      { worktree: path.join("/checkouts", "feature-a"), marker },
    ]);
  });

  // Clone mode has one checkout and no `worktrees/` directory at all; the git
  // dir's own markers are the whole story there.
  it("reports markers in the git dir itself", async () => {
    await fs.writeFile(path.join(gitDir, "MERGE_HEAD"), "");

    await expect(probeInFlightGitOperations(gitDir)).resolves.toEqual([{ worktree: gitDir, marker: "MERGE_HEAD" }]);
  });

  it("falls back to the admin directory name when gitdir is missing or empty", async () => {
    const admin = path.join(gitDir, "worktrees", "feature-a");
    await fs.mkdir(admin, { recursive: true });
    await fs.writeFile(path.join(admin, "index.lock"), "");

    await expect(probeInFlightGitOperations(gitDir)).resolves.toEqual([
      { worktree: "feature-a", marker: "index.lock" },
    ]);
  });

  // git writes an absolute path to the checkout's `.git`, but a submodule or a
  // hand-made registration can point somewhere that is not named `.git`. Taking
  // the parent unconditionally would then name the wrong directory.
  it("reports a gitdir path that is not a .git file as it stands", async () => {
    const admin = path.join(gitDir, "worktrees", "feature-a");
    await fs.mkdir(admin, { recursive: true });
    await fs.writeFile(path.join(admin, "gitdir"), "/checkouts/feature-a/.git/modules/sub\n");
    await fs.writeFile(path.join(admin, "index.lock"), "");

    await expect(probeInFlightGitOperations(gitDir)).resolves.toEqual([
      { worktree: path.join("/checkouts", "feature-a", ".git", "modules", "sub"), marker: "index.lock" },
    ]);
  });

  it("treats a git dir with no worktrees/ directory as idle", async () => {
    await fs.writeFile(path.join(gitDir, "worktrees"), "");

    await expect(probeInFlightGitOperations(gitDir)).resolves.toEqual([]);
  });

  // A registration directory that cannot be listed could be hiding any of the
  // markers, so it must not read as an idle checkout.
  it("reports a worktree admin directory that cannot be listed", async () => {
    if (!(await symlinksSupported())) return;
    const worktreesDir = path.join(gitDir, "worktrees");
    await fs.mkdir(worktreesDir, { recursive: true });
    await fs.symlink("feature-a", path.join(worktreesDir, "feature-a"));

    const signals = await probeInFlightGitOperations(gitDir);

    expect(signals).toEqual([{ worktree: "feature-a", marker: "unreadable: ELOOP" }]);
  });

  it("reports worktree registrations that cannot be enumerated", async () => {
    if (!(await symlinksSupported())) return;
    const worktreesDir = path.join(gitDir, "worktrees");
    await fs.symlink("worktrees", worktreesDir);

    const signals = await probeInFlightGitOperations(gitDir);

    expect(signals).toEqual([{ worktree: worktreesDir, marker: "unreadable: ELOOP" }]);
  });

  it("reports every busy worktree, not just the first", async () => {
    const a = await registerWorktree("feature-a", "/checkouts/feature-a");
    const b = await registerWorktree("feature-b", "/checkouts/feature-b");
    await fs.writeFile(path.join(a, "index.lock"), "");
    await fs.mkdir(path.join(b, "rebase-merge"));

    const signals = await probeInFlightGitOperations(gitDir);

    expect(signals).toHaveLength(2);
    expect(signals.map((signal) => signal.worktree).sort()).toEqual([
      path.join("/checkouts", "feature-a"),
      path.join("/checkouts", "feature-b"),
    ]);
  });

  // A registration that vanishes between the `worktrees/` listing and the
  // per-directory read — `git worktree remove` or `git worktree prune` running
  // alongside — is not busy, it is gone. Reporting it as unreadable would wedge
  // force clean's gc on a checkout that no longer exists.
  it("treats an admin directory that disappeared as idle, not as unreadable", async () => {
    if (!(await symlinksSupported())) return;
    // The race needs `worktrees/` to LIST a name whose directory is then not
    // there to read — a plain absent entry never gets listed, so it proves
    // nothing. A dangling symlink is listed and then fails ENOENT on read,
    // which is exactly the shape `git worktree prune` leaves mid-flight.
    await fs.mkdir(path.join(gitDir, "worktrees"), { recursive: true });
    await fs.symlink(path.join(gitDir, "worktrees", "was-here"), path.join(gitDir, "worktrees", "ghost"));

    await expect(probeInFlightGitOperations(gitDir)).resolves.toEqual([]);
  });

  it("treats a worktree registration that is a file, not a directory, as idle", async () => {
    // Same reasoning one level down: ENOTDIR is a malformed registration, not a
    // git command in flight, and must not permanently block the gc.
    await fs.mkdir(path.join(gitDir, "worktrees"), { recursive: true });
    await fs.writeFile(path.join(gitDir, "worktrees", "not-a-dir"), "stray file");

    await expect(probeInFlightGitOperations(gitDir)).resolves.toEqual([]);
  });

  // One worktree can hold more than one marker at once — an interactive rebase
  // someone walked away from, with a command running inside it right now. The
  // error names what to clear, so naming only the first would send the user
  // after half of it.
  it("reports every marker in one worktree, not just the first", async () => {
    const adminDir = await registerWorktree("wt-many", "/w/feature-many");
    await fs.writeFile(path.join(adminDir, "index.lock"), "");
    await fs.mkdir(path.join(adminDir, "rebase-merge"), { recursive: true });

    const signals = await probeInFlightGitOperations(gitDir);

    expect(signals.map((signal) => signal.marker).sort()).toEqual(["index.lock", "rebase-merge"]);
    expect(signals.every((signal) => signal.worktree === "/w/feature-many")).toBe(true);
  });

  // HEAD.lock is held while git updates the ref, which is the exact instant a
  // commit's objects exist and nothing points at them yet — the window this
  // probe is for. Sampling showed it never overlapping index.lock, so dropping
  // it loses that window entirely rather than merely duplicating cover.
  it("reports a worktree holding HEAD.lock", async () => {
    const adminDir = await registerWorktree("wt-head", "/w/feature-head");
    await fs.writeFile(path.join(adminDir, "HEAD.lock"), "");

    await expect(probeInFlightGitOperations(gitDir)).resolves.toEqual([
      { worktree: "/w/feature-head", marker: "HEAD.lock" },
    ]);
  });

  it("formats signals as worktree (marker) pairs", () => {
    expect(
      formatGitBusySignals([
        { worktree: "/checkouts/a", marker: "index.lock" },
        { worktree: "/checkouts/b", marker: "MERGE_HEAD" },
      ]),
    ).toBe("/checkouts/a (index.lock), /checkouts/b (MERGE_HEAD)");
  });
});
