import * as fs from "fs/promises";
import * as path from "path";

import { GIT_CONSTANTS } from "../constants";
import { formatBytes } from "../utils/disk-space";
import { getErrorMessage } from "../utils/errors";
import { removeEmptiedTrashContainer, removeTrashPayload, trashDeleteHint } from "../utils/trash-container";
import { computeTrashRootHash } from "../utils/trash-root-hash";

import { summarizeTrashEntries } from "./trash.service";

import type { GitService } from "./git.service";
import type { Logger } from "./logger.service";
import type { RemovalAuditService } from "./removal-audit.service";
import type { TrashEntry, TrashService } from "./trash.service";
import type { Config } from "../types";

export interface ReapOptions {
  remoteRefsFresh?: boolean;
}

export interface TrashReapResult {
  deleted: number;
  orphanedRefsDeleted: number;
  skippedNotSelected: number;
  keepRefsMinted: string[];
  errors: string[];
}

export class TrashReaperService {
  private warnedInvalidPaths = new Set<string>();
  private warnedLegacyFlatRefs = false;

  constructor(
    private readonly config: Config,
    private readonly trashService: TrashService,
    private logger: Logger,
    private readonly removalAudit: RemovalAuditService,
    private readonly gitService: GitService,
  ) {}

  updateLogger(logger: Logger): void {
    this.logger = logger;
  }

  async reapExpiredUnlocked(now: Date = new Date(), options: ReapOptions = {}): Promise<TrashReapResult> {
    return this.reapUnlocked(now, null, options.remoteRefsFresh ?? false, true);
  }

  async purgeAllUnlocked(entryIds: readonly string[]): Promise<TrashReapResult> {
    return this.reapUnlocked(new Date(), new Set(entryIds), false, false);
  }

  async purgeEntryUnlocked(entryId: string): Promise<TrashReapResult> {
    return this.reapUnlocked(new Date(), new Set([entryId]), false, true);
  }

  private async reapUnlocked(
    now: Date,
    purgeIds: ReadonlySet<string> | null,
    remoteRefsFresh: boolean,
    honorKeepPin: boolean,
  ): Promise<TrashReapResult> {
    const purgeAll = purgeIds !== null;
    const result: TrashReapResult = {
      deleted: 0,
      orphanedRefsDeleted: 0,
      skippedNotSelected: 0,
      keepRefsMinted: [],
      errors: [],
    };
    if (!purgeAll && !this.trashService.isEnabled()) return result;

    let realRoot: string;
    try {
      realRoot = await fs.realpath(this.trashService.getTrashRoot());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.logger.debug(`Trash reaper: no trash root; skipping pin-ref sweep`);
        return result;
      }
      this.logger.warn(`⚠️ Trash reaper skipped: cannot resolve trash root: ${getErrorMessage(error)}`);
      result.errors.push(getErrorMessage(error));
      return result;
    }

    const listing = await this.trashService.listEntries();
    const entries = listing.entries;
    const invalid: string[] = [];
    for (const invalidPath of listing.invalid) {
      if (!(await this.removeIfCrashLeftover(invalidPath))) invalid.push(invalidPath);
    }
    for (const invalidPath of invalid) {
      if (this.warnedInvalidPaths.has(invalidPath)) continue;
      this.logger.warn(`⚠️ Trash reaper: leaving unrecognized entry '${invalidPath}' alone (no valid manifest)`);
    }
    this.warnedInvalidPaths = new Set(invalid);

    const reapedIds = new Set<string>();
    for (const entry of entries) {
      if (purgeIds !== null && !purgeIds.has(entry.manifest.id)) {
        result.skippedNotSelected++;
        continue;
      }
      const expiresAt = new Date(entry.manifest.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        this.logger.warn(`⚠️ Trash reaper: entry '${entry.manifest.id}' has an unparseable expiry; skipping`);
        continue;
      }
      if (!purgeAll && expiresAt.getTime() > now.getTime()) continue;

      try {
        const realEntry = await fs.realpath(entry.containerPath);
        if (!realEntry.startsWith(realRoot + path.sep)) {
          this.logger.warn(`⚠️ Trash reaper: entry '${entry.manifest.id}' resolves outside the trash root; skipping`);
          continue;
        }
      } catch (error) {
        this.logger.warn(
          `⚠️ Trash reaper: cannot verify path of entry '${entry.manifest.id}'; skipping: ${getErrorMessage(error)}`,
        );
        continue;
      }

      let keepRef: string | null = null;
      if (
        honorKeepPin &&
        entry.manifest.keepPinOnReap &&
        entry.manifest.headOid &&
        !(await this.commitsReachedARemote(entry.manifest.headOid, remoteRefsFresh))
      ) {
        keepRef = `${GIT_CONSTANTS.KEEP_REF_PREFIX}${entry.manifest.id}`;
        try {
          await this.gitService.updateRef(keepRef, entry.manifest.headOid);
          result.keepRefsMinted.push(keepRef);
        } catch (error) {
          this.logger.warn(
            `⚠️ Trash reaper: cannot create keep ref '${keepRef}' for '${entry.manifest.id}'; deferring reap: ${getErrorMessage(error)}`,
          );
          result.errors.push(`${entry.manifest.id}: ${getErrorMessage(error)}`);
          continue;
        }
      }

      const auditAction = purgeAll ? "trash_purge" : "trash_reap";
      try {
        await this.removalAudit.record({
          action: auditAction,
          result: "attempt",
          path: entry.manifest.originalPath,
          branch: entry.manifest.branch ?? undefined,
          trashId: entry.manifest.id,
          trashPath: entry.payloadPath,
        });
      } catch (auditError) {
        this.logger.warn(
          `⚠️ Trash reaper: cannot write audit log; skipping '${entry.manifest.id}': ${getErrorMessage(auditError)}`,
        );
        result.errors.push(`${entry.manifest.id}: ${getErrorMessage(auditError)}`);
        continue;
      }

      try {
        await removeTrashPayload(entry.containerPath);
      } catch (error) {
        await this.reportDeleteFailure(entry, auditAction, error, result.errors);
        continue;
      }

      if (entry.manifest.pinRef) {
        await this.gitService.deleteRef(entry.manifest.pinRef).catch((error: unknown) => {
          result.errors.push(`${entry.manifest.pinRef}: ${getErrorMessage(error)}`);
          this.logger.warn(
            `⚠️ Trash reaper: failed to delete pin ref '${entry.manifest.pinRef}': ${getErrorMessage(error)}`,
          );
        });
      }

      try {
        await removeEmptiedTrashContainer(entry.containerPath);
      } catch (error) {
        await this.reportDeleteFailure(entry, auditAction, error, result.errors);
        continue;
      }

      reapedIds.add(entry.manifest.id);
      result.deleted++;
      this.logger.info(
        `🗑️ Trash reaper: deleted ${purgeAll ? "trash" : "expired"} entry '${entry.manifest.id}' (trashed ${entry.manifest.deletedAt})`,
      );
      if (keepRef) {
        this.logger.info(
          `   Commits remain recoverable at '${keepRef}' (${entry.manifest.headOid}) — recover with: git branch <name> ${entry.manifest.headOid}`,
        );
      }
      await this.removalAudit
        .record({
          action: auditAction,
          result: "success",
          path: entry.manifest.originalPath,
          trashId: entry.manifest.id,
        })
        .catch((auditError: unknown) =>
          this.logger.warn(`⚠️ Failed to write trash audit record: ${getErrorMessage(auditError)}`),
        );
    }

    let containerNames: Set<string> | null = null;
    try {
      containerNames = new Set(await fs.readdir(realRoot));
    } catch (error) {
      this.logger.warn(`⚠️ Trash reaper: cannot scan trash root for pin-ref sweep: ${getErrorMessage(error)}`);
    }
    if (containerNames !== null) {
      const orphaned = await this.reapOrphanedPinRefs(containerNames);
      result.orphanedRefsDeleted = orphaned.deleted;
      result.errors.push(...orphaned.errors);
    }

    this.warnIfOverThreshold(entries.filter((entry) => !reapedIds.has(entry.manifest.id)));
    return result;
  }

  private async removeIfCrashLeftover(containerPath: string): Promise<boolean> {
    try {
      if (!(await fs.lstat(containerPath)).isDirectory()) return false;
      const names = await fs.readdir(containerPath);
      if (!names.every((name) => name.endsWith(".tmp"))) return false;
      for (const name of names) await fs.unlink(path.join(containerPath, name));
      await fs.rmdir(containerPath);
      this.logger.debug(`Trash reaper: removed empty container '${containerPath}'`);
      return true;
    } catch (error) {
      this.logger.debug(`Trash reaper: cannot remove '${containerPath}': ${getErrorMessage(error)}`);
      return false;
    }
  }

  private async commitsReachedARemote(headOid: string, remoteRefsFresh: boolean): Promise<boolean> {
    if (!remoteRefsFresh) return false;
    try {
      if ((await this.gitService.countCommitsNotOnAnyRemote(headOid)) !== 0) return false;
      this.logger.info(
        `   ${headOid} is reachable from a remote-tracking ref; no permanent keep ref needed for these commits`,
      );
      return true;
    } catch (error) {
      this.logger.debug(`Trash reaper: could not re-check '${headOid}' against the remotes: ${getErrorMessage(error)}`);
      return false;
    }
  }

  private async reportDeleteFailure(
    entry: TrashEntry,
    auditAction: "trash_reap" | "trash_purge",
    error: unknown,
    errors: string[],
  ): Promise<void> {
    const message = getErrorMessage(error);
    this.logger.warn(`⚠️ Trash reaper: failed to delete '${entry.manifest.id}': ${message}`);
    this.logger.warn(`   ${trashDeleteHint(entry.containerPath)}`);
    errors.push(`${entry.manifest.id}: ${message}`);
    await this.removalAudit
      .record({
        action: auditAction,
        result: "failure",
        path: entry.manifest.originalPath,
        trashId: entry.manifest.id,
        error: message,
      })
      .catch(() => undefined);
  }

  private async reapOrphanedPinRefs(containerNames: Set<string>): Promise<{ deleted: number; errors: string[] }> {
    const result = { deleted: 0, errors: [] as string[] };
    let refs: string[];
    try {
      refs = await this.gitService.listRefs(GIT_CONSTANTS.TRASH_REF_PREFIX.replace(/\/$/, ""));
    } catch (error) {
      this.logger.warn(`⚠️ Trash reaper: cannot list pin refs: ${getErrorMessage(error)}`);
      result.errors.push(getErrorMessage(error));
      return result;
    }

    const ownPrefix = `${GIT_CONSTANTS.TRASH_REF_PREFIX}${this.getTrashRootHash()}/`;

    for (const ref of refs) {
      if (!ref.startsWith(GIT_CONSTANTS.TRASH_REF_PREFIX)) continue;
      if (!ref.startsWith(ownPrefix)) {
        const suffix = ref.slice(GIT_CONSTANTS.TRASH_REF_PREFIX.length);
        if (suffix.length > 0 && !suffix.includes("/") && !this.warnedLegacyFlatRefs) {
          this.logger.warn(
            "⚠️ Trash reaper: leaving legacy flat trash pin refs alone; each is released when its own trash entry is restored or reaped",
          );
          this.warnedLegacyFlatRefs = true;
        }
        continue;
      }

      const id = ref.slice(ownPrefix.length);
      if (id.length === 0 || id.includes("/")) {
        this.logger.warn(`⚠️ Trash reaper: leaving unexpected ref '${ref}' alone`);
        continue;
      }
      if (containerNames.has(id)) continue;

      try {
        await this.gitService.deleteRef(ref);
        result.deleted++;
        this.logger.info(`🗑️ Trash reaper: deleted orphaned pin ref '${ref}'`);
      } catch (error) {
        this.logger.warn(`⚠️ Trash reaper: failed to delete orphaned pin ref '${ref}': ${getErrorMessage(error)}`);
        result.errors.push(`${ref}: ${getErrorMessage(error)}`);
      }
    }
    return result;
  }

  private getTrashRootHash(): string {
    return computeTrashRootHash(this.trashService.getTrashRoot());
  }

  private warnIfOverThreshold(remaining: TrashEntry[]): void {
    const warnSizeBytes = this.config.trash?.warnSizeBytes;
    if (warnSizeBytes === undefined) return;

    const summary = summarizeTrashEntries(remaining);
    if (summary.totalSizeBytes > warnSizeBytes) {
      const unmeasured = summary.unknownSizeCount > 0 ? `, plus ${summary.unknownSizeCount} not yet measured` : "";
      this.logger.warn(
        `⚠️ Trash holds at least ${formatBytes(summary.totalSizeBytes)} across ${summary.itemCount} entries${unmeasured} ` +
          `(threshold ${formatBytes(warnSizeBytes)}). Entries expire ${this.trashService.getRetentionDays()} days after removal.`,
      );
    }
  }
}
