import * as fs from "fs/promises";
import * as path from "path";

import { DEFAULT_CONFIG, GIT_CONSTANTS, METADATA_CONSTANTS } from "../constants";
import { atomicWriteFile } from "../utils/atomic-write";
import { isGitCreatableBranchName, isGitObjectId } from "../utils/git-validation";
import { getErrorMessage } from "../utils/errors";

import type { Logger } from "./logger.service";
import type { TrashEntry, TrashService } from "./trash.service";
import type { Config } from "../types";

// quarantineDirectory() wrote `<iso-timestamp-with-:.->-<original-name>`.
const REMOVED_ENTRY_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(.+)$/;

interface DivergedInfo {
  originalBranch?: string;
  divergedAt?: string;
  originalPath?: string;
  localCommit?: string;
  // The permanent `keep/<dirname>` ref divergeWorktree minted to hold this
  // backup's never-pushed commits. Adoption replaces it (see retireLegacyKeepRef).
  keepRef?: string;
}

// Adopts pre-trash `.removed/` quarantines and `.diverged/` backups into
// `.trash/` so they age out under the same retention policy. Only entries in
// the exact formats those flows wrote are adopted — anything else is warned
// about and left alone (the reaper never touches unmanifested content).
export class TrashMigrationService {
  constructor(
    private readonly config: Config,
    private readonly trashService: TrashService,
    private logger: Logger,
  ) {}

  updateLogger(logger: Logger): void {
    this.logger = logger;
  }

  isEnabled(): boolean {
    return this.trashService.isEnabled() && (this.config.trash?.migrateLegacy ?? DEFAULT_CONFIG.TRASH.MIGRATE_LEGACY);
  }

  async migrateLegacyUnlocked(): Promise<void> {
    if (!this.isEnabled()) return;
    await this.migrateRemovedDir();
    await this.migrateDivergedDir();
  }

  private async migrateRemovedDir(): Promise<void> {
    const removedDir = path.join(this.config.worktreeDir, GIT_CONSTANTS.REMOVED_DIR_NAME);
    const names = await this.listDirectories(removedDir);

    for (const name of names) {
      const match = REMOVED_ENTRY_RE.exec(name);
      const quarantinedAt = match ? this.parseQuarantineTimestamp(match[1]) : null;
      if (!match || !quarantinedAt) {
        this.logger.warn(`⚠️ Leaving unrecognized entry '${name}' in ${GIT_CONSTANTS.REMOVED_DIR_NAME}/ alone`);
        continue;
      }

      try {
        const entry = await this.trashService.trashDirectory({
          dirPath: path.join(removedDir, name),
          reason: "legacy-adopt",
          source: ".removed",
          legacyOriginalName: name,
          legacyQuarantinedAt: quarantinedAt,
          headOid: null,
          originalPath: path.join(this.config.worktreeDir, match[2]),
          auditAction: "trash_adopt",
        });
        this.logger.info(
          `♻️ Adopted '${name}' from ${GIT_CONSTANTS.REMOVED_DIR_NAME}/ as trash entry '${entry.manifest.id}'`,
        );
      } catch (error) {
        this.logger.warn(`⚠️ Failed to adopt '${name}' into trash: ${getErrorMessage(error)}`);
      }
    }

    await fs.rmdir(removedDir).catch(() => undefined);
  }

  private async migrateDivergedDir(): Promise<void> {
    const divergedDir = path.join(this.config.worktreeDir, GIT_CONSTANTS.DIVERGED_DIR_NAME);
    const names = await this.listDirectories(divergedDir);

    for (const name of names) {
      const dirPath = path.join(divergedDir, name);
      const info = await this.readDivergedInfo(dirPath);
      const quarantinedAt = info?.divergedAt ? new Date(info.divergedAt) : null;
      const hasOriginalPath = typeof info?.originalPath === "string" && info.originalPath.length > 0;
      // Validated, not merely truthy: readDivergedInfo is an unvalidated
      // JSON.parse, and anything readManifest would later refuse must not be
      // serialized into a manifest here — the adopted entry would be moved out
      // of .diverged/ and then never listed, restored, or reaped. So the two
      // fields that become `branch` and `headOid` are held to the same rules
      // readManifest applies to them, and an entry that fails stays in
      // .diverged/ where the legacy keep ref still protects it.
      const hasOriginalBranch =
        typeof info?.originalBranch === "string" && isGitCreatableBranchName(info.originalBranch);
      const hasValidLocalCommit =
        info?.localCommit == null || (typeof info.localCommit === "string" && isGitObjectId(info.localCommit));
      if (
        !info ||
        !hasOriginalBranch ||
        !hasOriginalPath ||
        !hasValidLocalCommit ||
        !quarantinedAt ||
        Number.isNaN(quarantinedAt.getTime())
      ) {
        this.logger.warn(
          `⚠️ Leaving entry '${name}' in ${GIT_CONSTANTS.DIVERGED_DIR_NAME}/ alone (no parseable ${METADATA_CONSTANTS.DIVERGED_INFO_FILE})`,
        );
        continue;
      }

      let entry: TrashEntry;
      try {
        // keepPinOnReap: a .diverged backup exists precisely because its
        // commits were never pushed — adoption must not weaken that to a
        // 30-day files-only entry. Entries whose commit can't be pinned
        // (missing localCommit, gc'd oid) fail adoption and stay in
        // .diverged/ forever, the pre-trash behavior.
        entry = await this.trashService.trashDirectory({
          dirPath,
          reason: "legacy-adopt",
          source: ".diverged",
          branch: info.originalBranch,
          legacyOriginalName: name,
          legacyQuarantinedAt: quarantinedAt,
          headOid: info.localCommit ?? null,
          originalPath: info.originalPath,
          auditAction: "trash_adopt",
          keepPinOnReap: true,
        });
      } catch (error) {
        // Nothing below runs for a failed adoption — in particular the legacy
        // keep ref is not touched, because the backup is still in .diverged/
        // and that ref is still the only thing holding its commits.
        this.logger.warn(`⚠️ Failed to adopt '${name}' into trash: ${getErrorMessage(error)}`);
        continue;
      }
      this.logger.info(
        `♻️ Adopted '${name}' from ${GIT_CONSTANTS.DIVERGED_DIR_NAME}/ as trash entry '${entry.manifest.id}'`,
      );
      await this.retireLegacyKeepRef(entry, info.keepRef);
    }

    await fs.rmdir(divergedDir).catch(() => undefined);
  }

  // Reached only after trashDirectory has resolved, which is the first moment
  // the replacement protection (pin ref, and a bundle unless the commits are
  // already on a remote) is durably on disk; every failure inside it puts the
  // directory back and throws, so the legacy ref survives untouched and the
  // next run retries the whole adoption. Release first, rewrite second: a
  // crash in between leaves the ref released — the outcome this exists for —
  // and a payload note that is merely out of date, where the other order would
  // leave an orphaned ref that nothing records at all.
  private async retireLegacyKeepRef(entry: TrashEntry, candidate: unknown): Promise<void> {
    let released = false;
    try {
      const outcome = await this.trashService.releaseAdoptedKeepRef(entry, candidate);
      released = outcome === "released";
      if (outcome === "rejected") {
        this.logger.warn(
          `⚠️ Leaving '${String(candidate)}' alone: ${METADATA_CONSTANTS.DIVERGED_INFO_FILE} for '${entry.manifest.legacyOriginalName}' names a ref that is not the keep ref this backup was preserved with`,
        );
      }
    } catch (error) {
      // The entry is adopted and protected either way, so a refused delete is
      // untidy rather than unsafe — and reporting it as a failed adoption
      // would be a lie. Name the ref so it can be dropped by hand.
      this.logger.warn(
        `⚠️ Adopted '${entry.manifest.legacyOriginalName}' but could not delete its legacy keep ref '${String(candidate)}'; drop it with 'sync-worktrees trash drop-keep-ref ${entry.manifest.legacyOriginalName}': ${getErrorMessage(error)}`,
      );
    }
    await this.rewriteAdoptedDivergedInfo(entry, released).catch((error: unknown) =>
      this.logger.warn(
        `⚠️ Adopted '${entry.manifest.legacyOriginalName}' but could not update its ${METADATA_CONSTANTS.DIVERGED_INFO_FILE}; it still describes the pre-trash recovery flow: ${getErrorMessage(error)}`,
      ),
    );
  }

  // `.diverged-info.json` is not the user's own file — divergeWorktree wrote it
  // into the backup — and its discard step names a TUI view that lists
  // `.diverged/` directories only, which this payload has just left. Nothing
  // the user put in the worktree is touched; only the fields the tool itself
  // owns are rewritten, in place and atomically, to the flow that now applies.
  // The trash-enabled diverge path already writes this same shape into a
  // payload, so an adopted entry ends up describing itself like a native one.
  private async rewriteAdoptedDivergedInfo(entry: TrashEntry, keepRefReleased: boolean): Promise<void> {
    const infoPath = path.join(entry.payloadPath, METADATA_CONSTANTS.DIVERGED_INFO_FILE);
    const raw = await fs.readFile(infoPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;

    const updated: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
    if (keepRefReleased) updated.keepRef = null;
    updated.trashId = entry.manifest.id;
    const branch = entry.manifest.branch ?? "<branch>";
    // Step 3 is deliberately not "nothing to do". An adopted backup is a
    // keepPinOnReap entry — its commits were never pushed, so the reaper mints
    // a permanent `keep/<id>` for them instead of letting expiry collect them.
    // Only the files age out. Saying otherwise here would leave this payload
    // describing a discard that does not actually discard, which is the exact
    // defect that made the old instruction wrong.
    updated.instruction = `This backup was adopted into the trash as '${entry.manifest.id}'${
      keepRefReleased ? " and the keep ref that used to hold it has been released" : ""
    }.
To preserve your changes:
  1. Review: git diff origin/${branch}
  2. Keep changes: git push --force-with-lease origin ${branch}
  3. Discard changes: the files age out with the trash retention window, but the commit does not — it is held by this entry until then and by a permanent 'keep/${entry.manifest.id}' ref afterwards. Drop that with 'sync-worktrees trash drop-keep-ref ${entry.manifest.id}' once you are sure. To get the files back before they expire: 'sync-worktrees trash restore ${entry.manifest.id}'

  Original worktree location: ${entry.manifest.originalPath}`;

    await atomicWriteFile(infoPath, JSON.stringify(updated, null, 2));
  }

  private async listDirectories(dirPath: string): Promise<string[]> {
    try {
      const dirents = await fs.readdir(dirPath, { withFileTypes: true });
      return dirents.filter((dirent) => dirent.isDirectory() && !dirent.isSymbolicLink()).map((dirent) => dirent.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(`⚠️ Cannot scan '${dirPath}' for legacy trash adoption: ${getErrorMessage(error)}`);
      }
      return [];
    }
  }

  private async readDivergedInfo(dirPath: string): Promise<DivergedInfo | null> {
    try {
      const raw = await fs.readFile(path.join(dirPath, METADATA_CONSTANTS.DIVERGED_INFO_FILE), "utf-8");
      return JSON.parse(raw) as DivergedInfo;
    } catch {
      return null;
    }
  }

  // quarantine timestamps replaced [:.] with "-": 2026-06-06T18-34-18-123Z
  private parseQuarantineTimestamp(raw: string): Date | null {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(raw);
    if (!match) return null;
    const date = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
