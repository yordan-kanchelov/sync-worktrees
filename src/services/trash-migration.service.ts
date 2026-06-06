import * as fs from "fs/promises";
import * as path from "path";

import { DEFAULT_CONFIG, GIT_CONSTANTS, METADATA_CONSTANTS } from "../constants";
import { getErrorMessage } from "../utils/lfs-error";

import type { Logger } from "./logger.service";
import type { TrashService } from "./trash.service";
import type { Config } from "../types";

// quarantineDirectory() wrote `<iso-timestamp-with-:.->-<original-name>`.
const REMOVED_ENTRY_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(.+)$/;

interface DivergedInfo {
  originalBranch?: string;
  divergedAt?: string;
  originalPath?: string;
  localCommit?: string;
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
      const deletedAt = match ? this.parseQuarantineTimestamp(match[1]) : null;
      if (!match || !deletedAt) {
        this.logger.warn(`⚠️ Leaving unrecognized entry '${name}' in ${GIT_CONSTANTS.REMOVED_DIR_NAME}/ alone`);
        continue;
      }

      try {
        const entry = await this.trashService.trashDirectory({
          dirPath: path.join(removedDir, name),
          reason: "legacy-adopt",
          source: ".removed",
          legacyOriginalName: name,
          deletedAt,
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
      const deletedAt = info?.divergedAt ? new Date(info.divergedAt) : null;
      const hasOriginalPath = typeof info?.originalPath === "string" && info.originalPath.length > 0;
      if (!info || !info.originalBranch || !hasOriginalPath || !deletedAt || Number.isNaN(deletedAt.getTime())) {
        this.logger.warn(
          `⚠️ Leaving entry '${name}' in ${GIT_CONSTANTS.DIVERGED_DIR_NAME}/ alone (no parseable ${METADATA_CONSTANTS.DIVERGED_INFO_FILE})`,
        );
        continue;
      }

      try {
        const entry = await this.trashService.trashDirectory({
          dirPath,
          reason: "legacy-adopt",
          source: ".diverged",
          branch: info.originalBranch,
          legacyOriginalName: name,
          deletedAt,
          headOid: info.localCommit ?? null,
          originalPath: info.originalPath,
          auditAction: "trash_adopt",
        });
        this.logger.info(
          `♻️ Adopted '${name}' from ${GIT_CONSTANTS.DIVERGED_DIR_NAME}/ as trash entry '${entry.manifest.id}'`,
        );
      } catch (error) {
        this.logger.warn(`⚠️ Failed to adopt '${name}' into trash: ${getErrorMessage(error)}`);
      }
    }

    await fs.rmdir(divergedDir).catch(() => undefined);
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
