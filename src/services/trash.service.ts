import { randomBytes } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { DEFAULT_CONFIG, GIT_CONSTANTS, PATH_CONSTANTS, TRASH_CONSTANTS } from "../constants";
import { TrashOperationError } from "../errors";
import { atomicWriteFile } from "../utils/atomic-write";
import { calculateDirectorySize } from "../utils/disk-space";
import { probePathExists } from "../utils/file-exists";
import { getErrorMessage } from "../utils/lfs-error";

import type { GitService } from "./git.service";
import type { Logger } from "./logger.service";
import type { RemovalAuditService } from "./removal-audit.service";
import type { Config } from "../types";

export type TrashReason = "prune" | "orphan" | "diverged-replace" | "manual" | "legacy-adopt";

export interface TrashManifest {
  schemaVersion: number;
  id: string;
  deletedAt: string;
  expiresAt: string;
  originalPath: string;
  branch: string | null;
  reason: TrashReason;
  sizeBytes: number | null;
  headOid: string | null;
  pinRef: string | null;
  /** Bundle of the pinned commits not on any remote, relative to the container; null when nothing to bundle. */
  bundleFile?: string | null;
  source: "worktree" | ".removed" | ".diverged";
  legacyOriginalName: string | null;
  /** When the legacy quarantine flow originally preserved this entry; retention still counts from adoption. */
  legacyQuarantinedAt?: string | null;
  // When true the reaper moves the pin to a permanent keep ref instead of
  // unpinning. Set for removals authorized only by "fully pushed before
  // upstream deletion" proof — the remote may have deleted an unmerged
  // branch, so the commits must never become gc-eligible silently.
  keepPinOnReap?: boolean;
}

export interface TrashEntry {
  manifest: TrashManifest;
  containerPath: string;
  payloadPath: string;
}

export interface TrashSummary {
  itemCount: number;
  totalSizeBytes: number;
  unknownSizeCount: number;
  soonestExpiresAt: string | null;
}

export function isWorktreeRestorable(manifest: Pick<TrashManifest, "branch" | "headOid" | "pinRef">): boolean {
  return manifest.branch !== null && manifest.headOid !== null && manifest.pinRef !== null;
}

export function summarizeTrashEntries(entries: TrashEntry[]): TrashSummary {
  let totalSizeBytes = 0;
  let unknownSizeCount = 0;
  let soonest: string | null = null;

  for (const { manifest } of entries) {
    if (manifest.sizeBytes === null) {
      unknownSizeCount++;
    } else {
      totalSizeBytes += manifest.sizeBytes;
    }
    if (soonest === null || manifest.expiresAt < soonest) {
      soonest = manifest.expiresAt;
    }
  }

  return { itemCount: entries.length, totalSizeBytes, unknownSizeCount, soonestExpiresAt: soonest };
}

export interface TrashDirectoryOptions {
  dirPath: string;
  reason: TrashReason;
  branch?: string | null;
  source?: TrashManifest["source"];
  legacyOriginalName?: string | null;
  /** When the legacy flow originally quarantined the directory. Forensic only —
   * retention always counts from adoption time so a just-adopted entry can
   * never be reaped in the same tick. */
  legacyQuarantinedAt?: Date;
  /** Explicit HEAD oid (legacy adoption); `undefined` resolves from dirPath when branch is set. */
  headOid?: string | null;
  /** Where restore should put the payload back; defaults to dirPath. */
  originalPath?: string;
  auditAction?: "trash_create" | "trash_adopt";
  keepPinOnReap?: boolean;
}

// Reversible removal: directories land in <worktreeDir>/.trash/<id>/payload
// with a manifest sidecar and (when a commit is known) a pin ref that keeps
// the trashed HEAD's objects alive through `git gc` until the reaper runs.
export class TrashService {
  constructor(
    private readonly config: Config,
    private readonly gitService: GitService,
    private logger: Logger,
    private readonly removalAudit: RemovalAuditService,
  ) {}

  updateLogger(logger: Logger): void {
    this.logger = logger;
  }

  isEnabled(): boolean {
    return this.config.trash?.enabled ?? DEFAULT_CONFIG.TRASH.ENABLED;
  }

  getTrashRoot(): string {
    return path.join(this.config.worktreeDir, GIT_CONSTANTS.TRASH_DIR_NAME);
  }

  getRetentionDays(): number {
    return this.config.trash?.retentionDays ?? DEFAULT_CONFIG.TRASH.RETENTION_DAYS;
  }

  async trashDirectory(options: TrashDirectoryOptions): Promise<TrashEntry> {
    const deletedAt = new Date();
    const expiresAt = new Date(deletedAt.getTime() + this.getRetentionDays() * 86_400_000);
    const keepPinOnReap = options.keepPinOnReap ?? false;

    const headOid = options.headOid !== undefined ? options.headOid : await this.resolveHeadOid(options);
    if (keepPinOnReap && !headOid) {
      throw new TrashOperationError(
        "trash-directory",
        `cannot create keep-on-reap trash entry for '${options.dirPath}': HEAD commit could not be resolved`,
      );
    }
    const sizeBytes = await calculateDirectorySize(options.dirPath).catch(() => null);

    // Non-recursive container mkdir + EEXIST retry: the undo path below may
    // rm -rf the container, so it must never adopt one it didn't create.
    await fs.mkdir(this.getTrashRoot(), { recursive: true });
    const { id, containerPath } = await this.createContainer(deletedAt, path.basename(options.dirPath));

    const manifest: TrashManifest = {
      schemaVersion: TRASH_CONSTANTS.SCHEMA_VERSION,
      id,
      deletedAt: deletedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      originalPath: path.resolve(options.originalPath ?? options.dirPath),
      branch: options.branch ?? null,
      reason: options.reason,
      sizeBytes,
      headOid,
      pinRef: null,
      bundleFile: null,
      source: options.source ?? "worktree",
      legacyOriginalName: options.legacyOriginalName ?? null,
      legacyQuarantinedAt: options.legacyQuarantinedAt?.toISOString() ?? null,
      keepPinOnReap,
    };

    // Manifest goes down BEFORE the pin ref: a crash in between leaves a
    // valid (payload-less) entry that ages out normally, instead of an
    // unrecognized container the reaper warns about forever while its pin
    // keeps objects alive indefinitely.
    try {
      await this.writeManifest(containerPath, manifest);
    } catch (error) {
      await this.undoPartialTrash(containerPath, null);
      throw new TrashOperationError(
        "trash-directory",
        `cannot write trash manifest for '${options.dirPath}': ${getErrorMessage(error)}`,
        error instanceof Error ? error : undefined,
      );
    }

    const pinRef = headOid ? await this.createPinRef(id, headOid) : null;
    if (keepPinOnReap && !pinRef) {
      await this.undoPartialTrash(containerPath, pinRef);
      throw new TrashOperationError(
        "trash-directory",
        `cannot create keep-on-reap trash entry '${id}' for '${options.dirPath}': pin ref could not be created`,
      );
    }
    // Keep-on-reap entries may hold the only copy of their commits anywhere,
    // so a self-contained bundle backs up the pin ref; failure aborts the
    // removal (fail-closed) while the source directory is still untouched.
    let bundleFile: string | null = null;
    if (keepPinOnReap && pinRef) {
      try {
        const created = await this.gitService.createBundleFromRef(
          path.join(containerPath, TRASH_CONSTANTS.BUNDLE_FILENAME),
          pinRef,
        );
        bundleFile = created ? TRASH_CONSTANTS.BUNDLE_FILENAME : null;
      } catch (error) {
        await this.undoPartialTrash(containerPath, pinRef);
        throw new TrashOperationError(
          "trash-directory",
          `cannot bundle commits for keep-on-reap trash entry '${id}': ${getErrorMessage(error)}`,
          error instanceof Error ? error : undefined,
        );
      }
    }
    const payloadPath = path.join(containerPath, TRASH_CONSTANTS.PAYLOAD_DIRNAME);
    manifest.pinRef = pinRef;
    manifest.bundleFile = bundleFile;

    try {
      await this.writeManifest(containerPath, manifest);
      await fs.rename(options.dirPath, payloadPath);
    } catch (error) {
      await this.undoPartialTrash(containerPath, pinRef);
      const hint =
        (error as NodeJS.ErrnoException).code === "EXDEV"
          ? " (trash lives inside worktreeDir; a cross-device rename means the directory is on a different filesystem — co-locate it or set trash.enabled=false)"
          : "";
      throw new TrashOperationError(
        "trash-directory",
        `cannot move '${options.dirPath}' to trash${hint}: ${getErrorMessage(error)}`,
        error instanceof Error ? error : undefined,
      );
    }

    await this.removalAudit
      .record({
        action: options.auditAction ?? "trash_create",
        result: "success",
        path: manifest.originalPath,
        branch: manifest.branch ?? undefined,
        trashId: id,
        trashPath: payloadPath,
      })
      .catch((auditError: unknown) =>
        this.logger.warn(`⚠️ Failed to write trash audit record: ${getErrorMessage(auditError)}`),
      );

    return { manifest, containerPath, payloadPath };
  }

  async listEntries(): Promise<{ entries: TrashEntry[]; invalid: string[] }> {
    const root = this.getTrashRoot();
    const entries: TrashEntry[] = [];
    const invalid: string[] = [];

    let dirents;
    try {
      dirents = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { entries, invalid };
      }
      throw error;
    }

    for (const dirent of dirents) {
      const containerPath = path.join(root, dirent.name);
      if (dirent.isSymbolicLink()) {
        invalid.push(containerPath);
        continue;
      }
      if (!dirent.isDirectory()) {
        continue;
      }
      const manifest = await this.readManifest(containerPath);
      if (manifest === null) {
        invalid.push(containerPath);
        continue;
      }
      entries.push({
        manifest,
        containerPath,
        payloadPath: path.join(containerPath, TRASH_CONSTANTS.PAYLOAD_DIRNAME),
      });
    }

    return { entries, invalid };
  }

  // The full reversible-removal sequence shared by prune and manual removal:
  // payload to trash, dangling registration cleared, branch ref deleted.
  // A ref-delete failure is a hygiene problem, not a failed removal — the
  // payload and pin ref already capture everything restore needs, and restore
  // tolerates a leftover ref at the trashed commit.
  async trashAndUnregisterWorktree(options: {
    dirPath: string;
    branch: string | null;
    reason: TrashReason;
    keepPinOnReap?: boolean;
  }): Promise<{ entry: TrashEntry; branchRefError?: string }> {
    const entry = await this.trashDirectory(options);
    // force is safe here: the directory was already moved to trash, so only
    // the dangling registration is being cleared.
    await this.gitService.removeWorktree(options.dirPath, { force: true });
    let branchRefError: string | undefined;
    try {
      await this.deleteTrashedBranchRef(entry.manifest);
    } catch (refError) {
      branchRefError = getErrorMessage(refError);
      this.logger.warn(
        `⚠️ Leftover branch ref '${entry.manifest.branch}' after trashing '${entry.manifest.id}': ${branchRefError}`,
      );
    }
    return { entry, branchRefError };
  }

  async restore(id: string): Promise<TrashManifest> {
    const { entries } = await this.listEntries();
    const entry = entries.find((candidate) => candidate.manifest.id === id);
    if (!entry) {
      throw new TrashOperationError("restore", `no trash entry with id '${id}'`);
    }

    const { manifest, containerPath, payloadPath } = entry;

    if ((await probePathExists(payloadPath)) !== "exists") {
      throw new TrashOperationError("restore", `payload missing or unverifiable for '${id}' at '${payloadPath}'`);
    }
    const destinationProbe = await probePathExists(manifest.originalPath);
    if (destinationProbe !== "missing") {
      const why = destinationProbe === "exists" ? "already exists" : "cannot be verified";
      const hint =
        manifest.reason === "diverged-replace" && destinationProbe === "exists"
          ? " — a fresh worktree replaced this one when the branch diverged; remove that worktree first, or copy the files you need out of the trash payload manually"
          : "";
      throw new TrashOperationError("restore", `destination '${manifest.originalPath}' ${why}${hint}`);
    }

    // Worktree restore needs the pin: without it gc may already have collected
    // the trashed HEAD's objects, so promise only what is guaranteed — files.
    if (isWorktreeRestorable(manifest)) {
      await this.restoreAsWorktree(manifest, payloadPath);
    } else {
      if (manifest.branch) {
        this.logger.warn(
          `⚠️ Trash entry '${id}' has no pinned commit; restoring files only — the directory will not be a registered worktree.`,
        );
      }
      await fs.rename(payloadPath, manifest.originalPath);
    }

    // The payload is back in place — from here on, cleanup failures must not
    // fail the restore (a rejected retry would see "payload missing").
    await fs
      .rm(containerPath, { recursive: true, force: true })
      .catch((error: unknown) =>
        this.logger.warn(`⚠️ Failed to remove restored trash container '${containerPath}': ${getErrorMessage(error)}`),
      );
    if (manifest.pinRef) {
      await this.gitService
        .deleteRef(manifest.pinRef)
        .catch((error: unknown) =>
          this.logger.warn(`⚠️ Failed to delete pin ref '${manifest.pinRef}': ${getErrorMessage(error)}`),
        );
    }

    await this.removalAudit
      .record({
        action: "trash_restore",
        result: "success",
        path: manifest.originalPath,
        branch: manifest.branch ?? undefined,
        trashId: id,
      })
      .catch((auditError: unknown) =>
        this.logger.warn(`⚠️ Failed to write trash audit record: ${getErrorMessage(auditError)}`),
      );

    return manifest;
  }

  async deleteTrashedBranchRef(manifest: Pick<TrashManifest, "branch" | "id" | "pinRef">): Promise<void> {
    if (!manifest.branch) return;
    // Without a pin the branch ref may be the last thing keeping the trashed
    // commits out of gc — leave it as a hygiene problem rather than risk them.
    if (!manifest.pinRef) {
      this.logger.warn(
        `⚠️ Keeping branch ref '${manifest.branch}' after trashing '${manifest.id}': entry has no pin ref, so the ref is the only gc protection left`,
      );
      return;
    }

    try {
      await this.gitService.deleteLocalBranch(manifest.branch);
    } catch (error) {
      throw new TrashOperationError(
        "trash-branch-ref",
        `cannot delete branch ref '${manifest.branch}' after trashing '${manifest.id}': ${getErrorMessage(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  private async restoreAsWorktree(manifest: TrashManifest, payloadPath: string): Promise<void> {
    const branch = manifest.branch as string;
    const headOid = manifest.headOid as string;
    const existingBranchOid = await this.gitService.getLocalBranchCommit(branch);
    let createdBranch = false;

    if (existingBranchOid !== null && existingBranchOid !== headOid) {
      throw new TrashOperationError(
        "restore",
        `branch '${branch}' already exists at ${existingBranchOid}; expected trashed commit ${headOid}. Restore the files manually from '${payloadPath}' or move that branch first`,
      );
    }

    if (existingBranchOid === null) {
      await this.gitService.createBranchAt(branch, headOid);
      createdBranch = true;
    }

    try {
      await this.gitService.addWorktreeNoCheckout(branch, manifest.originalPath);
      await this.copyPayloadOver(payloadPath, manifest.originalPath);
      await this.gitService.resetWorktreeIndex(manifest.originalPath);
      // The payload was checked out under the sparse profile when it was
      // trashed; the fresh registration must carry the same sparse config or
      // git status would report every out-of-cone file as deleted.
      if (this.config.sparseCheckout) {
        await this.gitService
          .getSparseCheckoutService()
          .applyToWorktree(manifest.originalPath, this.config.sparseCheckout);
      }
    } catch (error) {
      await this.gitService
        .removeWorktree(manifest.originalPath, { force: true })
        .catch((rollbackError: unknown) =>
          this.logger.warn(`⚠️ Restore rollback (worktree) failed: ${getErrorMessage(rollbackError)}`),
        );
      if (createdBranch) {
        await this.gitService
          .deleteLocalBranch(branch)
          .catch((rollbackError: unknown) =>
            this.logger.warn(`⚠️ Restore rollback (branch) failed: ${getErrorMessage(rollbackError)}`),
          );
      }
      throw new TrashOperationError(
        "restore",
        `failed to recreate worktree for '${manifest.id}'; trash entry left intact: ${getErrorMessage(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  // The payload's top-level .git link points at a pruned admin dir; the fresh
  // one written by `worktree add --no-checkout` must survive the overlay.
  private async copyPayloadOver(payloadPath: string, destination: string): Promise<void> {
    await fs.cp(payloadPath, destination, {
      recursive: true,
      force: true,
      filter: (source) => !(path.dirname(source) === payloadPath && path.basename(source) === PATH_CONSTANTS.GIT_DIR),
    });
  }

  private async resolveHeadOid(options: TrashDirectoryOptions): Promise<string | null> {
    if (!options.branch) return null;
    try {
      return (await this.gitService.getCurrentCommit(options.dirPath)).trim();
    } catch (error) {
      this.logger.warn(
        `⚠️ Could not resolve HEAD for '${options.dirPath}'; trash entry will preserve files only: ${getErrorMessage(error)}`,
      );
      return null;
    }
  }

  // Pin failure degrades to a files-only trash entry rather than blocking the
  // removal — the payload itself is still fully preserved either way.
  private async createPinRef(id: string, headOid: string): Promise<string | null> {
    const refName = `${GIT_CONSTANTS.TRASH_REF_PREFIX}${id}`;
    try {
      await this.gitService.updateRef(refName, headOid);
      return refName;
    } catch (error) {
      this.logger.warn(
        `⚠️ Could not pin '${headOid}' for trash entry '${id}'; git gc may collect its objects: ${getErrorMessage(error)}`,
      );
      return null;
    }
  }

  private async writeManifest(containerPath: string, manifest: TrashManifest): Promise<void> {
    const manifestPath = path.join(containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME);
    await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
  }

  private async readManifest(containerPath: string): Promise<TrashManifest | null> {
    try {
      const raw = await fs.readFile(path.join(containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME), "utf-8");
      const parsed = JSON.parse(raw) as TrashManifest;
      if (
        typeof parsed.id !== "string" ||
        typeof parsed.expiresAt !== "string" ||
        typeof parsed.originalPath !== "string"
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async undoPartialTrash(containerPath: string, pinRef: string | null): Promise<void> {
    await fs.rm(containerPath, { recursive: true, force: true }).catch(() => undefined);
    if (pinRef) {
      await this.gitService.deleteRef(pinRef).catch(() => undefined);
    }
  }

  private async createContainer(deletedAt: Date, baseName: string): Promise<{ id: string; containerPath: string }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = this.generateId(deletedAt, baseName);
      const containerPath = path.join(this.getTrashRoot(), id);
      try {
        await fs.mkdir(containerPath);
        return { id, containerPath };
      } catch (error) {
        lastError = error;
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") break;
      }
    }
    throw new TrashOperationError(
      "trash-directory",
      `cannot create trash container for '${baseName}': ${getErrorMessage(lastError)}`,
      lastError instanceof Error ? lastError : undefined,
    );
  }

  // The id doubles as a refname component (refs/sync-worktrees/trash/<id>).
  // The timestamp prefix and hex suffix rule out leading dots and ".lock"
  // endings, but ".." inside the name would still make the ref invalid and
  // silently degrade the entry to files-only.
  private generateId(deletedAt: Date, baseName: string): string {
    const timestamp = deletedAt.toISOString().replace(/[:.]/g, "-");
    const safeName = baseName.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.{2,}/g, "_");
    return `${timestamp}-${safeName}-${randomBytes(3).toString("hex")}`;
  }
}
