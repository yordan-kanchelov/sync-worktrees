import pLimit from "p-limit";

import { DEFAULT_CONFIG } from "../constants";
import { Logger } from "../services/logger.service";
import { WorktreeSyncService } from "../services/worktree-sync.service";
import { getErrorMessage } from "../utils/errors";
import { redactSecretsInText } from "../utils/git-url";
import { formatRepoLockUnavailable } from "../utils/repo-lock-format";

import type { SyncDryRunPlan, SyncDryRunStep, SyncPlanResult } from "../services/sync-plan";
import type { ConfigFile, RepositoryConfig } from "../types";

export interface DryRunOptions {
  json: boolean;
  debug: boolean;
}

/** One repository's line in `sync --dry-run --json`. */
export type DryRunReport =
  | { name: string; status: "planned"; plan: SyncDryRunPlan }
  | { name: string; status: "not_started"; reason: "in_progress" | "locked" | "lock_unavailable"; message: string }
  | { name: string; status: "failed"; error: string };

/**
 * `sync --dry-run`: plans every selected repository — the same decisions a
 * sync would take, computed by the sync's own assessments — prints the plans
 * and changes nothing. Returns the exit code: 1 when any repository could not
 * be planned (an error, or a lock that could not be taken at all), else 0.
 * A repository whose lock another process holds is reported, not failed,
 * the same way `--run-once` treats it.
 */
export async function runDryRun(
  configFile: ConfigFile,
  repositories: RepositoryConfig[],
  options: DryRunOptions,
): Promise<number> {
  const maxParallel =
    configFile.parallelism?.maxRepositories ??
    configFile.defaults?.parallelism?.maxRepositories ??
    DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES;
  const limit = pLimit(maxParallel);

  const reports = await Promise.all(
    repositories.map((repoConfig) =>
      limit(async (): Promise<DryRunReport> => {
        // Logs are for --debug; the plan is the output. Under --json stdout
        // carries nothing but the JSON, so the loggers stay quiet there even
        // with --debug (warnings and errors still reach stderr).
        const quiet = options.json || !options.debug;
        const logger = repoConfig.logger ?? Logger.createDefault(repoConfig.name, repoConfig.debug, { quiet });
        try {
          const service = new WorktreeSyncService({ ...repoConfig, logger });
          return toReport(repoConfig.name, await service.planSync());
        } catch (error) {
          return { name: repoConfig.name, status: "failed", error: redactSecretsInText(getErrorMessage(error)) };
        }
      }),
    ),
  );

  if (options.json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    for (const line of formatDryRunReports(reports)) console.log(line);
  }

  return reports.some(
    (report) => report.status === "failed" || (report.status === "not_started" && report.reason === "lock_unavailable"),
  )
    ? 1
    : 0;
}

function toReport(name: string, result: SyncPlanResult): DryRunReport {
  if (result.started) return { name, status: "planned", plan: result.plan };
  const message =
    result.reason === "lock_unavailable"
      ? formatRepoLockUnavailable(result)
      : result.reason === "locked"
        ? "another process holds the repository lock (a sync is running)"
        : "another repository operation is in progress";
  return { name, status: "not_started", reason: result.reason, message };
}

const STEP_SYMBOLS: Record<SyncDryRunStep["kind"], string> = {
  clone: "⬇",
  create: "+",
  update: "↑",
  replace: "⇄",
  remove: "✗",
  skip: "⏭",
  noop: "✓",
};

// What a reason code means, for the codes whose outcome records carry no
// message of their own. Anything not listed is shown with its underscores
// turned into spaces.
const REASON_LABELS: Readonly<Record<string, string>> = {
  new_branch: "new branch on origin",
  missing_directory: "directory is missing; rebuilt",
  default_branch: "default-branch worktree (fetches run from it)",
  fast_forward: "fast-forward",
  reset_identical_tree: "reset to origin",
  reset_no_local_changes: "reset to origin",
  sparse_checkout: "sparse-checkout",
  dirty_worktree: "working tree has local changes",
  local_ahead: "has unpushed commits",
  missing_worktree_path: "worktree directory is missing",
  operation_in_progress: "a merge, rebase or similar is in progress",
  outside_sparse_checkout: "upstream changes are all outside the sparse-checkout paths",
  unsafe_to_remove: "kept",
  worktree_locked: "locked",
  path_collision: "path collision",
  external_worktree: "external worktree",
  reserved_by_trash: "reserved by trash",
  fully_pushed_trash_disabled: "kept",
};

function describeReason(reason: string): string {
  return REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
}

function describeStep(step: SyncDryRunStep): string {
  switch (step.kind) {
    case "clone":
      return step.message;
    case "create":
      return `${step.path} (${describeReason(step.reason)})`;
    case "update":
      return step.message ? `${describeReason(step.reason)}: ${step.message}` : describeReason(step.reason);
    case "replace":
    case "remove":
      return step.message;
    case "skip":
    case "noop":
      return step.message ? `${describeReason(step.reason)}: ${step.message}` : describeReason(step.reason);
  }
}

function stepSubject(step: SyncDryRunStep): string {
  return step.branch ?? "";
}

/** The human-readable report: one block per repository, then a summary line. */
export function formatDryRunReports(reports: readonly DryRunReport[]): string[] {
  const lines: string[] = ["📋 Dry run: nothing below has been done."];
  const totals = { clone: 0, create: 0, update: 0, replace: 0, remove: 0, skip: 0, noop: 0 };
  let failed = 0;
  let notStarted = 0;
  let fetched = false;

  for (const report of reports) {
    lines.push("");
    if (report.status === "failed") {
      failed++;
      lines.push(`❌ ${report.name}: could not plan: ${report.error}`);
      continue;
    }
    if (report.status === "not_started") {
      notStarted++;
      lines.push(`⏭  ${report.name}: not planned: ${report.message}`);
      continue;
    }

    const { plan } = report;
    fetched ||= plan.fetched;
    for (const kind of Object.keys(totals) as Array<keyof typeof totals>) totals[kind] += plan.counts[kind];
    lines.push(`📦 ${report.name} (${plan.mode} mode)`);
    const shown = plan.steps.filter((step) => step.kind !== "noop");
    const width = Math.max(0, ...shown.map((step) => stepSubject(step).length));
    for (const step of shown) {
      const subject = stepSubject(step).padEnd(width);
      lines.push(`   ${STEP_SYMBOLS[step.kind]} ${step.kind.padEnd(7)} ${subject}  ${describeStep(step)}`.trimEnd());
    }
    if (plan.counts.noop > 0) {
      lines.push(`   ${STEP_SYMBOLS.noop} ${plan.counts.noop} up to date`);
    }
    if (plan.steps.length === 0) {
      lines.push("   ✓ nothing to do");
    }
    for (const note of plan.notes) lines.push(`   ℹ ${note}`);
  }

  const parts = [
    totals.clone > 0 ? `${totals.clone} to clone` : null,
    `${totals.create} to create`,
    `${totals.update} to update`,
    `${totals.remove} to remove`,
    totals.replace > 0 ? `${totals.replace} to replace` : null,
    `${totals.skip} skipped`,
    failed > 0 ? `${failed} failed` : null,
    notStarted > 0 ? `${notStarted} not planned` : null,
  ].filter((part): part is string => part !== null);
  lines.push("");
  lines.push(
    `📊 Dry run of ${reports.length} ${reports.length === 1 ? "repository" : "repositories"}: ${parts.join(", ")}.`,
  );
  lines.push(
    fetched
      ? "   Nothing was changed; origin was fetched (remote-tracking refs only) so the plan matches it now."
      : "   Nothing was changed.",
  );
  return lines;
}
