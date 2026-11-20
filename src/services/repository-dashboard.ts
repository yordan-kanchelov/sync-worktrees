import { getErrorMessage } from "../utils/errors";
import { redactSecretsInText } from "../utils/git-url";
import { formatRepoLockUnavailable } from "../utils/repo-lock-format";

import type { WorktreeSyncService } from "./worktree-sync.service";
import type { SyncOutcomeCounts, SyncResult, WorktreeStatusEntry } from "../types";
import type { AppEventEmitter, RepositoryDashboardRow, RepositoryRunState } from "../utils/app-events";

export type RepositorySyncSettlement =
  { status: "fulfilled"; result: SyncResult | undefined } | { status: "rejected"; error: unknown };

export interface RepositoryDashboardHost {
  readonly events: AppEventEmitter;
  getServices(): readonly WorktreeSyncService[];
  getRepoName(index: number): string;
  scheduleFor(service: WorktreeSyncService): string | undefined;
  isActive(): boolean;
}

interface RepositoryRecord {
  state: RepositoryRunState;
  lastResult: string | null;
  lastSyncAt: number | null;
  worktrees: number | null;
  changes: { dirty: number; unpushed: number } | null;
}

const FRESH: RepositoryRecord = { state: "idle", lastResult: null, lastSyncAt: null, worktrees: null, changes: null };

const SKIP_REASONS: Record<string, string> = {
  in_progress: "busy with another sync or operation",
  locked: "locked by another process",
};

function describeCounts(counts: SyncOutcomeCounts): string {
  const parts = [
    counts.created > 0 ? `${counts.created} created` : "",
    counts.updated > 0 ? `${counts.updated} updated` : "",
    counts.removed > 0 ? `${counts.removed} removed` : "",
    counts.preserved > 0 ? `${counts.preserved} preserved` : "",
    counts.skipped > 0 ? `${counts.skipped} skipped` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "up to date";
}

function firstLine(message: string): string {
  const line = message.split(/\r?\n/).find((part) => part.trim().length > 0) ?? message;
  return redactSecretsInText(line.trim());
}

export function describeSettlement(settled: RepositorySyncSettlement): {
  state: Exclude<RepositoryRunState, "syncing">;
  lastResult: string;
} {
  if (settled.status === "rejected") {
    return { state: "failed", lastResult: firstLine(getErrorMessage(settled.error)) };
  }
  const result = settled.result;
  if (result && result.started === false) {
    if (result.reason === "lock_unavailable") {
      return { state: "failed", lastResult: firstLine(formatRepoLockUnavailable(result)) };
    }
    return { state: "skipped", lastResult: SKIP_REASONS[result.reason] ?? result.reason };
  }
  const counts = result?.outcome?.counts;
  if (counts && counts.failed > 0) {
    return { state: "failed", lastResult: `${counts.failed} action(s) failed; ${describeCounts(counts)}` };
  }
  return { state: "idle", lastResult: counts ? describeCounts(counts) : "synced" };
}

export class RepositoryDashboard {
  private records = new Map<string, RepositoryRecord>();
  private syncingAs = new WeakMap<WorktreeSyncService, string>();
  private readonly now: () => number;

  constructor(
    private readonly host: RepositoryDashboardHost,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  private nameOf(service: WorktreeSyncService): string | null {
    const index = this.host.getServices().indexOf(service);
    return index === -1 ? null : this.host.getRepoName(index);
  }

  private update(name: string | null, change: Partial<RepositoryRecord>): void {
    if (name === null) return;
    this.records.set(name, { ...(this.records.get(name) ?? FRESH), ...change });
    this.publish();
  }

  public markSyncing(service: WorktreeSyncService): void {
    const name = this.nameOf(service);
    if (name !== null) this.syncingAs.set(service, name);
    this.update(name, { state: "syncing" });
  }

  public recordSettlement(service: WorktreeSyncService, settled: RepositorySyncSettlement): void {
    const name = this.nameOf(service) ?? this.syncingAs.get(service) ?? null;
    this.syncingAs.delete(service);
    const { state, lastResult } = describeSettlement(settled);
    this.update(name, state === "skipped" ? { state, lastResult } : { state, lastResult, lastSyncAt: this.now() });
    if (name !== null && state !== "skipped") {
      void this.refreshWorktreeCount(service, name);
    }
  }

  private async refreshWorktreeCount(service: WorktreeSyncService, name: string): Promise<void> {
    if (typeof service.getWorktrees !== "function") return;
    try {
      const worktrees = await service.getWorktrees();
      if (this.nameOf(service) !== name) return;
      this.update(name, { worktrees: worktrees.length });
    } catch {}
  }

  public recordWorktreeStatus(repoIndex: number, entries: readonly WorktreeStatusEntry[]): void {
    const services = this.host.getServices();
    if (repoIndex < 0 || repoIndex >= services.length) return;
    const probed = entries.filter((entry) => entry.error === undefined);
    this.update(this.host.getRepoName(repoIndex), {
      worktrees: entries.length,
      changes: {
        dirty: probed.filter((entry) => !entry.status.isClean).length,
        unpushed: probed.filter((entry) => entry.status.hasUnpushedCommits).length,
      },
    });
  }

  public snapshot(): RepositoryDashboardRow[] {
    return this.host.getServices().map((service, index) => {
      const name = this.host.getRepoName(index);
      const record = this.records.get(name) ?? FRESH;
      const schedule = this.host.scheduleFor(service);
      return { name, ...record, ...(schedule !== undefined && { schedule }) };
    });
  }

  public publish(): void {
    if (!this.host.isActive()) return;
    const rows = this.snapshot();
    const current = new Set(rows.map((row) => row.name));
    for (const name of this.records.keys()) {
      if (!current.has(name)) this.records.delete(name);
    }
    this.host.events.emit("setRepositoryDashboard", rows);
  }
}
