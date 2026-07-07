import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { GIT_CONSTANTS } from "../constants";
import { formatBytes } from "../utils/disk-space";
import { getErrorMessage } from "../utils/lfs-error";

import { summarizeTrashEntries } from "./trash.service";

import type { GitService } from "./git.service";
import type { Logger } from "./logger.service";
import type { RemovalAuditService } from "./removal-audit.service";
import type { TrashEntry, TrashService } from "./trash.service";
import type { Config } from "../types";

// Deletes expired trash entries at the tail of a successful sync, inside the
// already-held repo lock. Same fail-closed discipline as the removal pipeline:
// only manifested entries whose realpath stays under the trash root, and only
// after the attempt is durably recorded in the audit log.
export class TrashReaperService {
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
  async reapExpiredUnlocked(now: Date = new Date()): Promise<void> {
    if (!this.trashService.isEnabled()) return;

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
        return;
      }
      this.logger.warn(`⚠️ Trash reaper skipped: cannot resolve trash root: ${getErrorMessage(error)}`);
      return;
    }

    const { entries, invalid } = await this.trashService.listEntries();
    for (const invalidPath of invalid) {
      this.logger.warn(`⚠️ Trash reaper: leaving unrecognized entry '${invalidPath}' alone (no valid manifest)`);
    }

    const reapedIds = new Set<string>();
    for (const entry of entries) {
      const expiresAt = new Date(entry.manifest.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        this.logger.warn(`⚠️ Trash reaper: entry '${entry.manifest.id}' has an unparseable expiry; skipping`);
        continue;
      }
      if (expiresAt.getTime() > now.getTime()) continue;

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
      if (entry.manifest.keepPinOnReap && entry.manifest.headOid) {
        keepRef = `${GIT_CONSTANTS.KEEP_REF_PREFIX}${entry.manifest.id}`;
        try {
          await this.gitService.updateRef(keepRef, entry.manifest.headOid);
        } catch (error) {
          this.logger.warn(
            `⚠️ Trash reaper: cannot create keep ref '${keepRef}' for '${entry.manifest.id}'; deferring reap: ${getErrorMessage(error)}`,
          );
          continue;
        }
      }

      try {
        await this.removalAudit.record({
          action: "trash_reap",
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
        continue;
      }

      try {
        await fs.rm(entry.containerPath, { recursive: true, force: true });
      } catch (error) {
        this.logger.warn(`⚠️ Trash reaper: failed to delete '${entry.manifest.id}': ${getErrorMessage(error)}`);
        await this.removalAudit
          .record({
            action: "trash_reap",
            result: "failure",
            path: entry.manifest.originalPath,
            trashId: entry.manifest.id,
            error: getErrorMessage(error),
          })
          .catch(() => undefined);
        continue;
      }

      if (entry.manifest.pinRef) {
        await this.gitService
          .deleteRef(entry.manifest.pinRef)
          .catch((error: unknown) =>
            this.logger.warn(
              `⚠️ Trash reaper: failed to delete pin ref '${entry.manifest.pinRef}': ${getErrorMessage(error)}`,
            ),
          );
      }

      reapedIds.add(entry.manifest.id);
      this.logger.info(
        `🗑️ Trash reaper: deleted expired entry '${entry.manifest.id}' (trashed ${entry.manifest.deletedAt})`,
      );
      if (keepRef) {
        this.logger.info(
          `   Commits remain recoverable at '${keepRef}' (${entry.manifest.headOid}) — recover with: git branch <name> ${entry.manifest.headOid}`,
        );
      }
      await this.removalAudit
        .record({
          action: "trash_reap",
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
      await this.reapOrphanedPinRefs(containerNames);
    }

    this.warnIfOverThreshold(entries.filter((entry) => !reapedIds.has(entry.manifest.id)));
  }

  // Pin refs whose trash container is gone would pin objects forever (failed
  // ref delete during restore, manually emptied trash). Keyed on container
  // existence, NOT manifest validity — an invalid-manifest entry still owns
  // its pin because the reaper refuses to delete its payload. Deliberately
  // any dirent name counts (files, symlinks): deleting a pin is irreversible
  // once gc runs, while a stray name collision merely keeps one ref alive.
  private async reapOrphanedPinRefs(containerNames: Set<string>): Promise<void> {
    let refs: string[];
    try {
      refs = await this.gitService.listRefs(GIT_CONSTANTS.TRASH_REF_PREFIX.replace(/\/$/, ""));
    } catch (error) {
      this.logger.warn(`⚠️ Trash reaper: cannot list pin refs: ${getErrorMessage(error)}`);
      return;
    }

    const ownPrefix = `${GIT_CONSTANTS.TRASH_REF_PREFIX}${this.getTrashRootHash()}/`;
    let warnedLegacy = false;

    for (const ref of refs) {
      if (!ref.startsWith(GIT_CONSTANTS.TRASH_REF_PREFIX)) continue;
      if (!ref.startsWith(ownPrefix)) {
        const suffix = ref.slice(GIT_CONSTANTS.TRASH_REF_PREFIX.length);
        if (suffix.length > 0 && !suffix.includes("/") && !warnedLegacy) {
          this.logger.warn("⚠️ Trash reaper: leaving legacy flat trash pin refs alone");
          warnedLegacy = true;
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
        this.logger.info(`🗑️ Trash reaper: deleted orphaned pin ref '${ref}'`);
      } catch (error) {
        this.logger.warn(`⚠️ Trash reaper: failed to delete orphaned pin ref '${ref}': ${getErrorMessage(error)}`);
      }
    }
  }

  private getTrashRootHash(): string {
    return createHash("sha256").update(path.resolve(this.trashService.getTrashRoot())).digest("hex").slice(0, 16);
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
