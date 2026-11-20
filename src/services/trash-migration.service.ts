import * as fs from "fs/promises";
import * as path from "path";

import { DEFAULT_CONFIG, GIT_CONSTANTS, METADATA_CONSTANTS } from "../constants";
import { atomicWriteFile } from "../utils/atomic-write";
import { isGitCreatableBranchName, isGitObjectId } from "../utils/git-validation";
import { getErrorMessage } from "../utils/errors";

import type { Logger } from "./logger.service";
import type { TrashEntry, TrashService } from "./trash.service";
import type { Config } from "../types";

const REMOVED_ENTRY_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(.+)$/;

interface DivergedInfo {
  originalBranch?: string;
  divergedAt?: string;
  originalPath?: string;
  localCommit?: string;
  keepRef?: string;
}

export class TrashMigrationService {
  private warned = new Set<string>();
  private warnedThisRun = new Set<string>();

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
    this.warnedThisRun = new Set();
    try {
      await this.migrateRemovedDir();
      await this.migrateDivergedDir();
    } finally {
      this.warned = this.warnedThisRun;
    }
  }

  private warnOnce(message: string): void {
    this.warnedThisRun.add(message);
    if (!this.warned.has(message)) this.logger.warn(message);
  }

  private async migrateRemovedDir(): Promise<void> {
    const removedDir = path.join(this.config.worktreeDir, GIT_CONSTANTS.REMOVED_DIR_NAME);
    const names = await this.listDirectories(removedDir);

    for (const name of names) {
      const match = REMOVED_ENTRY_RE.exec(name);
      const quarantinedAt = match ? this.parseQuarantineTimestamp(match[1]) : null;
      if (!match || !quarantinedAt) {
        this.warnOnce(`⚠️ Leaving unrecognized entry '${name}' in ${GIT_CONSTANTS.REMOVED_DIR_NAME}/ alone`);
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
        this.warnOnce(`⚠️ Failed to adopt '${name}' into trash: ${getErrorMessage(error)}`);
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
        this.warnOnce(
          `⚠️ Leaving entry '${name}' in ${GIT_CONSTANTS.DIVERGED_DIR_NAME}/ alone (no parseable ${METADATA_CONSTANTS.DIVERGED_INFO_FILE})`,
        );
        continue;
      }

      let entry: TrashEntry;
      try {
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
        this.warnOnce(`⚠️ Failed to adopt '${name}' into trash: ${getErrorMessage(error)}`);
        continue;
      }
      this.logger.info(
        `♻️ Adopted '${name}' from ${GIT_CONSTANTS.DIVERGED_DIR_NAME}/ as trash entry '${entry.manifest.id}'`,
      );
      await this.retireLegacyKeepRef(entry, info.keepRef);
    }

    await fs.rmdir(divergedDir).catch(() => undefined);
  }

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

  private async rewriteAdoptedDivergedInfo(entry: TrashEntry, keepRefReleased: boolean): Promise<void> {
    const infoPath = path.join(entry.payloadPath, METADATA_CONSTANTS.DIVERGED_INFO_FILE);
    const raw = await fs.readFile(infoPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;

    const updated: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
    if (keepRefReleased) updated.keepRef = null;
    updated.trashId = entry.manifest.id;
    const branch = entry.manifest.branch ?? "<branch>";
    updated.instruction = `This backup was adopted into the trash as '${entry.manifest.id}'${
      keepRefReleased ? " and the keep ref that used to hold it has been released" : ""
    }.
This copy is detached from git: do not run git inside it.
  1. Recover the commits: git -C ${this.trashService.getBareRepoPath()} branch ${branch}-recovered ${entry.manifest.headOid}
  2. Get the files back: sync-worktrees trash restore ${entry.manifest.id}
  3. Discard changes: the files age out with the trash retention window, but the commit does not — it is held by this entry until then and by a permanent 'keep/${entry.manifest.id}' ref afterwards. Drop that with 'sync-worktrees trash drop-keep-ref ${entry.manifest.id}' once you are sure.

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

  private parseQuarantineTimestamp(raw: string): Date | null {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(raw);
    if (!match) return null;
    const date = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
