import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { formatDryRunReports, runDryRun } from "../dry-run";

import type { SyncDryRunPlan, SyncPlanResult } from "../../services/sync-plan";
import type { RepositoryConfig } from "../../types";
import type { DryRunReport } from "../dry-run";

vi.mock("../../services/worktree-sync.service", () => ({
  WorktreeSyncService: vi.fn(),
}));

const repo = (name: string): RepositoryConfig => ({
  name,
  repoUrl: `https://example.com/org/${name}.git`,
  worktreeDir: `/work/${name}`,
  cronSchedule: "0 * * * *",
  runOnce: false,
});

const plan: SyncDryRunPlan = {
  repoName: "app",
  mode: "worktree",
  fetched: true,
  notes: ["a note"],
  steps: [
    { kind: "create", branch: "feature/new", path: "/work/app/feature-new", reason: "new_branch" },
    { kind: "update", branch: "behind", path: "/work/app/behind", reason: "fast_forward", message: "2 commits behind" },
    {
      kind: "remove",
      branch: "gone",
      path: "/work/app/gone",
      reason: "deleted_on_remote",
      basis: "fully_pushed_remote_deleted",
      disposal: "trash",
      message: "fully pushed, remote branch deleted; moved to trash",
    },
    { kind: "skip", scope: "worktree", branch: "dirty", path: "/work/app/dirty", reason: "dirty_worktree" },
    { kind: "noop", scope: "worktree", branch: "main", path: "/work/app/main", reason: "already_up_to_date" },
  ],
  counts: { clone: 0, create: 1, update: 1, replace: 0, remove: 1, skip: 1, noop: 1 },
};

describe("sync --dry-run report", () => {
  it("prints one line per step, folds up-to-date worktrees into a count, and says nothing changed", () => {
    const lines = formatDryRunReports([{ name: "app", status: "planned", plan }]);
    const text = lines.join("\n");

    expect(text).toContain("📦 app (worktree mode)");
    expect(text).toMatch(/\+ create\s+feature\/new\s+\/work\/app\/feature-new \(new branch on origin\)/);
    expect(text).toMatch(/↑ update\s+behind\s+fast-forward: 2 commits behind/);
    expect(text).toMatch(/✗ remove\s+gone\s+fully pushed, remote branch deleted; moved to trash/);
    expect(text).toMatch(/⏭ skip\s+dirty\s+working tree has local changes/);
    expect(text).toContain("✓ 1 up to date");
    expect(text).not.toMatch(/noop/);
    expect(text).toContain("ℹ a note");
    expect(text).toContain("📊 Dry run of 1 repository: 1 to create, 1 to update, 1 to remove, 1 skipped.");
    expect(text).toContain("Nothing was changed; origin was fetched");
  });

  it("labels a kept fully-pushed worktree without repeating its reason code", () => {
    const text = formatDryRunReports([
      {
        name: "app",
        status: "planned",
        plan: {
          ...plan,
          notes: [],
          steps: [
            {
              kind: "skip",
              scope: "worktree",
              branch: "stale",
              reason: "fully_pushed_trash_disabled",
              message: "fully pushed before upstream deletion; trash disabled",
            },
          ],
          counts: { clone: 0, create: 0, update: 0, replace: 0, remove: 0, skip: 1, noop: 0 },
        },
      },
    ]).join("\n");

    expect(text).toMatch(/⏭ skip\s+stale\s+kept: fully pushed before upstream deletion; trash disabled/);
    expect(text).not.toContain("fully pushed trash disabled");
  });

  it("reports repositories it could not plan, and ones another process holds", () => {
    const text = formatDryRunReports([
      { name: "broken", status: "failed", error: "boom" },
      { name: "busy", status: "not_started", reason: "locked", message: "another process holds the repository lock" },
    ]).join("\n");

    expect(text).toContain("❌ broken: could not plan: boom");
    expect(text).toContain("⏭  busy: not planned: another process holds the repository lock");
    expect(text).toContain("1 failed, 1 not planned");
    expect(text).toContain("   Nothing was changed.");
  });
});

describe("runDryRun", () => {
  let stdout: string[];
  const planSync = vi.fn<() => Promise<SyncPlanResult>>();

  beforeEach(() => {
    stdout = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => stdout.push(line));
    planSync.mockReset();
    vi.mocked(WorktreeSyncService).mockImplementation(function (this: { planSync: typeof planSync }) {
      this.planSync = planSync;
    } as unknown as typeof WorktreeSyncService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the plans as JSON and exits 0 when every repository was planned or is busy", async () => {
    planSync.mockResolvedValueOnce({ started: true, plan }).mockResolvedValueOnce({ started: false, reason: "locked" });

    const code = await runDryRun({ repositories: [] }, [repo("app"), repo("busy")], {
      json: true,
      debug: false,
    });

    expect(code).toBe(0);
    const reports = JSON.parse(stdout.join("\n")) as DryRunReport[];
    expect(reports).toEqual([
      { name: "app", status: "planned", plan },
      { name: "busy", status: "not_started", reason: "locked", message: expect.stringContaining("lock") },
    ]);
  });

  it("exits 1 when a repository could not be planned, with its credentials scrubbed", async () => {
    planSync.mockRejectedValueOnce(new Error("fetch failed for https://user:s3cret@example.com/org/app.git"));

    const code = await runDryRun({ repositories: [] }, [repo("app")], { json: true, debug: false });

    expect(code).toBe(1);
    const [report] = JSON.parse(stdout.join("\n")) as DryRunReport[];
    expect(report).toMatchObject({ name: "app", status: "failed" });
    expect(JSON.stringify(report)).not.toContain("s3cret");
  });

  it("exits 1 when a repository's lock cannot be taken at all", async () => {
    planSync.mockResolvedValueOnce({
      started: false,
      reason: "lock_unavailable",
      path: "/work/.sync-worktrees-locks",
      code: "EACCES",
      error: "permission denied",
    });

    const code = await runDryRun({ repositories: [] }, [repo("app")], { json: false, debug: false });

    expect(code).toBe(1);
    expect(stdout.join("\n")).toContain("app: not planned:");
  });
});
