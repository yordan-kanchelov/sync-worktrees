import * as fs from "fs/promises";
import * as path from "path";

import { GIT_CONSTANTS } from "../constants";
import { formatBytes } from "../utils/disk-space";
import { getErrorMessage } from "../utils/lfs-error";
import { removeEmptiedTrashContainer, removeTrashPayload, trashDeleteHint } from "../utils/trash-container";
import { computeTrashRootHash } from "../utils/trash-root-hash";

import { summarizeTrashEntries } from "./trash.service";

import type { GitService } from "./git.service";
import type { Logger } from "./logger.service";
import type { RemovalAuditService } from "./removal-audit.service";
import type { TrashEntry, TrashService } from "./trash.service";
import type { Config } from "../types";

export interface TrashReapResult {
  deleted: number;
  orphanedRefsDeleted: number;
  /** Entries present on disk that the caller's purge selection did not name. */
  skippedNotSelected: number;
  errors: string[];
}

// Deletes expired trash entries at the tail of a successful sync, inside the
// already-held repo lock. Same fail-closed discipline as the removal pipeline:
// only manifested entries whose realpath stays under the trash root, and only
// after the attempt is durably recorded in the audit log.
export class TrashReaperService {
  // Unrecognized containers and legacy flat pin refs are steady states the
  // reaper deliberately never acts on, so repeating the warning on every tick
  // (hourly, for as long as the process lives) is noise that buries the lines
  // that do need attention. Warn when the situation first appears and stay
  // quiet until it changes; the trash listing and the force-clean preview
  // report invalid entries independently, so nothing becomes invisible.
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

  // Disabled trash means "don't touch my trash" — existing entries are left
  // alone rather than aged out behind the user's back.
  async reapExpiredUnlocked(now: Date = new Date()): Promise<TrashReapResult> {
    return this.reapUnlocked(now, null);
  }

  // Purges exactly the entries named by `entryIds` — the set a force-clean
  // confirmation was shown — regardless of expiry. Ids whose entry is no longer
  // there (reaped since, or half-deleted so its manifest no longer parses) are
  // simply not found among the listed entries and cost nothing; entries that
  // are there but unnamed are left alone and counted in `skippedNotSelected`.
  async purgeAllUnlocked(entryIds: readonly string[]): Promise<TrashReapResult> {
    return this.reapUnlocked(new Date(), new Set(entryIds));
  }

  private async reapUnlocked(now: Date, purgeIds: ReadonlySet<string> | null): Promise<TrashReapResult> {
    const purgeAll = purgeIds !== null;
    const result: TrashReapResult = { deleted: 0, orphanedRefsDeleted: 0, skippedNotSelected: 0, errors: [] };
    if (!purgeAll && !this.trashService.isEnabled()) return result;

    let realRoot: string;
    try {
      realRoot = await fs.realpath(this.trashService.getTrashRoot());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A missing trash root is NOT proof the trash is empty — worktreeDir
        // may be an unmounted volume that sync just recreated empty. Sweeping
        // pins here would let gc collect objects whose manifests reappear on
        // remount. Pins from a manually deleted trash root linger only until
        // the next trashDirectory recreates the root and the sweep resumes.
        this.logger.debug(`Trash reaper: no trash root; skipping pin-ref sweep`);
        return result;
      }
      this.logger.warn(`⚠️ Trash reaper skipped: cannot resolve trash root: ${getErrorMessage(error)}`);
      result.errors.push(getErrorMessage(error));
      return result;
    }

    const { entries, invalid } = await this.trashService.listEntries();
    for (const invalidPath of invalid) {
      if (this.warnedInvalidPaths.has(invalidPath)) continue;
      this.logger.warn(`⚠️ Trash reaper: leaving unrecognized entry '${invalidPath}' alone (no valid manifest)`);
    }
    // Rebuilt rather than added to, so an entry that is repaired and later
    // breaks again is reported again instead of staying silently suppressed.
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

      // "Fully pushed before upstream deletion" entries keep their commits
      // alive past payload expiry: move the pin to a permanent keep ref BEFORE
      // deleting anything. On failure defer the whole reap to the next run —
      // these commits may be the only copy left anywhere.
      let keepRef: string | null = null;
      if (!purgeAll && entry.manifest.keepPinOnReap && entry.manifest.headOid) {
        keepRef = `${GIT_CONSTANTS.KEEP_REF_PREFIX}${entry.manifest.id}`;
        try {
          await this.gitService.updateRef(keepRef, entry.manifest.headOid);
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

      // Payload first (see removeTrashPayload): a refusal here leaves the
      // manifest in place, so the entry stays listed and expired — this run
      // reports it with a hint, the next one retries it.
      try {
        await removeTrashPayload(entry.containerPath);
      } catch (error) {
        await this.reportDeleteFailure(entry, auditAction, error, result.errors);
        continue;
      }

      // The pin outlives the payload only until here. Releasing it before the
      // manifest goes means a refused container delete can no longer strand a
      // ref that nothing would come back for: the sweep below keys on the
      // container name, which still exists.
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

  // Pin refs whose trash container is gone would pin objects forever (failed
  // ref delete during restore, manually emptied trash). Keyed on container
  // existence, NOT manifest validity — an invalid-manifest entry still owns
  // its pin because the reaper refuses to delete its payload. Deliberately
  // any dirent name counts (files, symlinks): deleting a pin is irreversible
  // once gc runs, while a stray name collision merely keeps one ref alive.
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
      this.logger.warn(
        `⚠️ Trash holds ${formatBytes(summary.totalSizeBytes)} across ${summary.itemCount} entries ` +
          `(threshold ${formatBytes(warnSizeBytes)}). Entries expire ${this.trashService.getRetentionDays()} days after removal.`,
      );
    }
  }
}
