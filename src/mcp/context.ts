import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import pLimit from "p-limit";

import { DEFAULT_CONFIG, GIT_CONSTANTS } from "../constants";
import { ConfigLoaderService } from "../services/config-loader.service";
import { Logger } from "../services/logger.service";
import { PathResolutionService } from "../services/path-resolution.service";
import { WorktreeSyncService } from "../services/worktree-sync.service";
import { findConfigUpTree } from "../utils/config-discovery";
import { createGitClient } from "../utils/git-client";
import { redactRepoUrl } from "../utils/git-url";
import { normalizePathForCompare, pathsEqual, resolveRealPathAsync } from "../utils/path-compare";
import { REPOSITORY_MODES, resolveMode } from "../utils/repo-mode";
import { parseWorktreeListPorcelain, readWorktreeListPorcelain } from "../utils/worktree-list-parser";

import type { Config, RepositoryConfig } from "../types";
import type { Divergence, WorktreeLabel } from "./worktree-summary";

export interface CapabilityState {
  available: boolean;
  reason?: string;
}

export interface Capabilities {
  listWorktrees: CapabilityState;
  getStatus: CapabilityState;
  createWorktree: CapabilityState;
  updateWorktree: CapabilityState;
  sync: CapabilityState;
  initialize: CapabilityState;
}

export interface DiscoveredWorktree {
  path: string;
  branch: string;
  isCurrent: boolean;
  label?: WorktreeLabel;
  divergence?: Divergence | null;
  staleHint?: boolean;
  statusError?: string;
  prunable?: boolean;
  locked?: boolean;
  detached?: boolean;
}

export interface SiblingRepository {
  name: string;
  bareRepoPath: string;
  worktreeDir: string | null;
  repoUrl: string | null;
  sparseCheckout?: RepositoryConfig["sparseCheckout"];
  present: boolean;
  configMatched: boolean;
}

interface ConfiguredRepositorySummaryBase {
  name: string;
  isCurrent: boolean;
  repoUrl?: string;
  branch?: string;
  sparseCheckout?: RepositoryConfig["sparseCheckout"];
  localReady?: boolean;
}

export interface ConfiguredCloneRepositorySummary extends ConfiguredRepositorySummaryBase {
  mode: "clone";
  checkoutPath: string;
}

export interface ConfiguredWorktreeRepositorySummary extends ConfiguredRepositorySummaryBase {
  mode: "worktree";
  worktreeDir: string;
  bareRepoDir?: string;
}

export type ConfiguredRepositorySummary = ConfiguredCloneRepositorySummary | ConfiguredWorktreeRepositorySummary;

export interface DiscoveredRepoContext {
  isWorktree: boolean;
  kind: "managed" | "unmanaged" | "unsupported";
  currentBranch: string | null;
  currentWorktreePath: string | null;
  bareRepoPath: string | null;
  repoUrl: string | null;
  worktreeDir: string | null;
  allWorktrees: DiscoveredWorktree[];
  allWorktreesByRepo?: Record<string, DiscoveredWorktree[]>;
  allWorktreeErrorsByRepo?: Record<string, string>;
  siblingRepositories: SiblingRepository[];
  configPath: string | null;
  repoName: string | null;
  capabilities: Capabilities;
  notes: string[];
}

interface RepoEntry {
  name: string;
  config: Config;
  source: "config" | "detected";
  service?: WorktreeSyncService;
  discovered?: DiscoveredRepoContext;
  worktreeDirUndetermined?: boolean;
  realPaths?: { bareRepoDir: string | null; worktreeDir: string };
}

type RepositorySelectionDecision =
  | { kind: "selected"; repoName: string; source: "current" | "explicit" | "single-config" }
  | { kind: "ambiguous"; configured: string[]; detected: string[]; reason: string }
  | { kind: "missing"; configured: string[]; detected: string[]; reason: string };

interface RepositorySelectionState {
  currentRepo: string | null;
  configured: string[];
  detected: string[];
  defaultDecision: RepositorySelectionDecision;
}

interface ConfigFingerprint {
  mtimeMs: number | null;
  contentHash: string | null;
}

interface ConfigLoadFailure extends ConfigFingerprint {
  path: string;
  error: string;
}

interface CachedDiscovery {
  result: DiscoveredRepoContext;
  cachedAt: number;
  worktreeAdminDir: string | null;
  worktreeHeadMtimeMs: number | null;
  worktreesDirMtimeMs: number | null;
}

const AUTO_DETECT_PREFIX = "__auto_detected__:";
const DISCOVERY_CACHE_TTL_MS = 5000;
const DISCOVERY_CACHE_LIMIT = 64;
const NO_REMOTE_URL_REASON = "no remote origin URL detected";
const NO_CONFIG_NO_URL_REASON = "no config and no remote URL";
const NOT_REGISTERED_NO_URL_REASON =
  "repository is not registered: no remote origin URL detected and no loaded config lists it; " +
  "add an origin remote, or list it in a config and call load_config";
const CLONE_MODE_REASON = "clone-mode repositories have a single checkout; use sync for clone-mode updates";
const UNDETERMINED_WORKTREE_DIR_REASON =
  "cannot determine worktreeDir: the registered worktrees and the worktree this call came from do not agree on " +
  "where they live; set an explicit worktreeDir in a config for this repository and call load_config";
const CONFIG_RECOVERY_HINT = "call load_config or detect_context from a configured workspace";

function emptyCapabilities(reason?: string): Capabilities {
  const state: CapabilityState = reason ? { available: false, reason } : { available: false };
  return {
    listWorktrees: { ...state },
    getStatus: { ...state },
    createWorktree: { ...state },
    updateWorktree: { ...state },
    sync: { ...state },
    initialize: { ...state },
  };
}

export function buildUnsupportedContext(currentPath: string, reason: string): DiscoveredRepoContext {
  return {
    isWorktree: false,
    kind: "unsupported",
    currentBranch: null,
    currentWorktreePath: currentPath,
    bareRepoPath: null,
    repoUrl: null,
    worktreeDir: null,
    allWorktrees: [],
    siblingRepositories: [],
    configPath: null,
    repoName: null,
    capabilities: emptyCapabilities(reason),
    notes: [reason],
  };
}

function createStderrLogger(repoName?: string): Logger {
  return new Logger({
    repoName,
    outputFn: (msg: string): void => {
      process.stderr.write(msg + "\n");
    },
  });
}

export class RepositoryContext {
  private repos = new Map<string, RepoEntry>();
  private currentRepo: string | null = null;
  private configPath: string | null = null;
  private configLoader = new ConfigLoaderService({ logger: createStderrLogger() });
  private discoveryCache = new Map<string, CachedDiscovery>();
  private lastConfigLoadFailure: ConfigLoadFailure | null = null;
  private loadedConfigFingerprint: ConfigFingerprint | null = null;
  private loadedConfigCheckedMtimeMs: number | null = null;
  private loadedConfigChanged = false;
  private readonly launchCwd: string;

  constructor(options: { launchCwd?: string } = {}) {
    this.launchCwd = path.resolve(options.launchCwd ?? process.cwd());
  }

  getLaunchCwd(): string {
    return this.launchCwd;
  }

  async findConfigUpTree(startDir: string): Promise<string | null> {
    return findConfigUpTree(startDir);
  }

  async loadConfig(configPath: string, options: { setDefaultCurrent?: boolean } = {}): Promise<RepositoryConfig[]> {
    const setDefaultCurrent = options.setDefaultCurrent ?? true;
    const absolutePath = path.resolve(configPath);
    const fingerprint = await configFileFingerprint(absolutePath);
    const { repositories: resolvedAll, configFile } = await this.configLoader.buildRepositories(absolutePath);
    const realPaths = await Promise.all(resolvedAll.map(realRepoPaths));

    for (const [name, entry] of this.repos) {
      if (entry.source === "config") {
        this.repos.delete(name);
      }
    }

    this.configPath = absolutePath;
    this.lastConfigLoadFailure = null;
    this.loadedConfigFingerprint = fingerprint;
    this.loadedConfigCheckedMtimeMs = fingerprint.mtimeMs;
    this.loadedConfigChanged = false;
    resolvedAll.forEach((resolved, i) => {
      this.repos.set(resolved.name, {
        name: resolved.name,
        config: resolved,
        source: "config",
        realPaths: realPaths[i],
      });
    });

    this.dropDetectedEntriesCoveredByConfig();

    if (this.currentRepo && !this.repos.has(this.currentRepo)) {
      this.currentRepo = null;
    }

    if (setDefaultCurrent && !this.currentRepo && resolvedAll.length === 1) {
      this.currentRepo = resolvedAll[0].name;
    }

    this.invalidateDiscovered();

    return configFile.repositories;
  }

  async detectFromPath(dirPath: string): Promise<DiscoveredRepoContext> {
    const lexicalPath = path.resolve(dirPath);
    const absolutePath = await resolveRealPathAsync(lexicalPath);
    await this.checkLoadedConfigChanged();

    const cached = this.discoveryCache.get(absolutePath);
    if (cached && (await this.isCacheFresh(cached))) {
      this.discoveryCache.delete(absolutePath);
      this.discoveryCache.set(absolutePath, cached);
      return cached.result;
    }

    if (this.configPath === null) {
      const found = await findConfigUpTree(lexicalPath);
      if (found === null) {
        this.lastConfigLoadFailure = null;
      } else {
        const fingerprint = await configFileFingerprint(found);
        if (this.shouldReimportConfig(found, fingerprint)) {
          try {
            await this.loadConfig(found, { setDefaultCurrent: false });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.lastConfigLoadFailure = { path: found, error: message, ...fingerprint };
            process.stderr.write(`[sync-worktrees] auto-loaded config failed: ${message}\n`);
          }
        }
      }
    }

    const { result, adminDir } = await this.detectFromPathUncached(absolutePath);

    if (result.isWorktree && result.bareRepoPath && adminDir) {
      const [worktreeHeadMtimeMs, worktreesDirMtimeMs] = await Promise.all([
        safeMtimeMs(path.join(adminDir, "HEAD")),
        safeMtimeMs(path.join(result.bareRepoPath, "worktrees")),
      ]);
      this.rememberDiscovery(absolutePath, {
        result,
        cachedAt: Date.now(),
        worktreeAdminDir: adminDir,
        worktreeHeadMtimeMs,
        worktreesDirMtimeMs,
      });
    }

    return result;
  }

  private rememberDiscovery(absolutePath: string, entry: CachedDiscovery): void {
    this.discoveryCache.delete(absolutePath);
    this.discoveryCache.set(absolutePath, entry);
    while (this.discoveryCache.size > DISCOVERY_CACHE_LIMIT) {
      const oldest = this.discoveryCache.keys().next();
      if (oldest.done === true) break;
      this.discoveryCache.delete(oldest.value);
    }
  }

  invalidateDiscovered(): void {
    this.discoveryCache.clear();
    for (const entry of this.repos.values()) {
      entry.discovered = undefined;
    }
  }

  __registerForTest(name: string, entry: Omit<RepoEntry, "name">): void {
    this.repos.set(name, { ...entry, name });
  }

  __setCurrentRepoForTest(name: string | null): void {
    this.currentRepo = name;
  }

  __discoveryCacheSizeForTest(): number {
    return this.discoveryCache.size;
  }

  private async discoverSiblingRepositories(currentBareRepoPath: string): Promise<SiblingRepository[]> {
    const currentBare = normalizePathForCompare(currentBareRepoPath);
    const results = new Map<string, SiblingRepository>();
    const byName = (a: SiblingRepository, b: SiblingRepository): number => a.name.localeCompare(b.name);

    const configCandidates = Array.from(this.repos.values())
      .filter((entry) => entry.source === "config" && !!entry.config.bareRepoDir)
      .filter((entry) => !configPathMatches(entry, "bareRepoDir", currentBareRepoPath))
      .map((entry) => {
        const bareRepoPath = path.resolve(entry.config.bareRepoDir as string);
        const realBare = entry.realPaths?.bareRepoDir ?? bareRepoPath;
        return { entry, bareRepoPath, foldedBare: normalizePathForCompare(realBare) };
      });

    const configPresence = await Promise.all(configCandidates.map((c) => isDirectory(c.bareRepoPath)));
    configCandidates.forEach(({ entry, bareRepoPath, foldedBare }, i) => {
      const sibling: SiblingRepository = {
        name: entry.name,
        bareRepoPath,
        worktreeDir: path.resolve(entry.config.worktreeDir),
        repoUrl: redactRepoUrl(entry.config.repoUrl),
        present: configPresence[i],
        configMatched: true,
      };
      if (entry.config.sparseCheckout) {
        sibling.sparseCheckout = entry.config.sparseCheckout;
      }
      results.set(foldedBare, sibling);
    });

    const repoDir = path.dirname(currentBareRepoPath);
    const workspaceRoot = path.dirname(repoDir);

    if (workspaceRoot === repoDir) {
      return Array.from(results.values()).sort(byName);
    }

    let entries: string[];
    try {
      entries = await fs.readdir(workspaceRoot);
    } catch {
      return Array.from(results.values()).sort(byName);
    }

    const configBares = new Map(configCandidates.map((c) => [c.foldedBare, c.entry.name]));

    await Promise.all(
      entries.map(async (entry) => {
        const candidate = path.join(workspaceRoot, entry);
        const bareCandidate = path.join(candidate, GIT_CONSTANTS.BARE_DIR_NAME);
        if (!(await isDirectory(bareCandidate))) return;

        const resolvedBare = path.resolve(bareCandidate);
        const foldedBare = normalizePathForCompare(resolvedBare);
        if (foldedBare === currentBare || results.has(foldedBare)) return;

        const matchedName = configBares.get(foldedBare);
        results.set(foldedBare, {
          name: matchedName ?? entry,
          bareRepoPath: resolvedBare,
          worktreeDir: null,
          repoUrl: null,
          present: true,
          configMatched: matchedName !== undefined,
        });
      }),
    );

    return Array.from(results.values()).sort(byName);
  }

  private bootstrapCurrentRepo(candidate: string, force = false): void {
    if (this.currentRepo !== null) {
      if (!force || this.repos.get(this.currentRepo)?.source !== "detected") return;
    }
    if (!this.repos.has(candidate)) return;
    if (!force && this.repos.size !== 1) return;
    this.currentRepo = candidate;
  }

  private dropDetectedEntriesCoveredByConfig(): void {
    for (const [name, entry] of this.repos) {
      if (entry.source !== "detected") continue;
      const match = this.findConfiguredEntryForDetected(entry);
      if (!match) continue;
      this.repos.delete(name);
      if (this.currentRepo === name) this.currentRepo = match.name;
    }
  }

  private findConfiguredEntryForDetected(detected: RepoEntry): RepoEntry | null {
    const discovered = detected.discovered;
    const detectedBare = discovered?.bareRepoPath ?? detected.config.bareRepoDir ?? null;
    const detectedWorktree = discovered?.currentWorktreePath ?? detected.config.worktreeDir;

    for (const entry of this.repos.values()) {
      if (entry.source !== "config") continue;
      if (detectedBare && configPathMatches(entry, "bareRepoDir", detectedBare)) {
        return entry;
      }
      if (
        resolveMode(entry.config) === REPOSITORY_MODES.CLONE &&
        configPathMatches(entry, "worktreeDir", detectedWorktree)
      ) {
        return entry;
      }
    }
    return null;
  }

  private async checkLoadedConfigChanged(): Promise<void> {
    const loaded = this.loadedConfigFingerprint;
    if (this.configPath === null || loaded === null || loaded.contentHash === null) return;
    const mtimeMs = await safeMtimeMs(this.configPath);
    if (mtimeMs !== null && mtimeMs === this.loadedConfigCheckedMtimeMs) return;
    const current = await configFileFingerprint(this.configPath);
    const changed = current.contentHash !== loaded.contentHash;
    this.loadedConfigCheckedMtimeMs = mtimeMs;
    if (changed !== this.loadedConfigChanged) {
      this.loadedConfigChanged = changed;
      this.discoveryCache.clear();
    }
  }

  private shouldReimportConfig(configPath: string, fingerprint: ConfigFingerprint): boolean {
    const failure = this.lastConfigLoadFailure;
    if (failure === null) return true;
    if (!pathsEqual(failure.path, configPath)) return true;
    if (fingerprint.contentHash === null || failure.contentHash === null) return true;
    return fingerprint.mtimeMs !== failure.mtimeMs || fingerprint.contentHash !== failure.contentHash;
  }

  private async isCacheFresh(cached: CachedDiscovery): Promise<boolean> {
    if (Date.now() - cached.cachedAt >= DISCOVERY_CACHE_TTL_MS) return false;
    if (!cached.worktreeAdminDir || !cached.result.bareRepoPath) return true;

    const [currentHeadMtime, currentWorktreesDirMtime] = await Promise.all([
      safeMtimeMs(path.join(cached.worktreeAdminDir, "HEAD")),
      safeMtimeMs(path.join(cached.result.bareRepoPath, "worktrees")),
    ]);

    return currentHeadMtime === cached.worktreeHeadMtimeMs && currentWorktreesDirMtime === cached.worktreesDirMtimeMs;
  }

  private async detectFromPathUncached(
    absolutePath: string,
  ): Promise<{ result: DiscoveredRepoContext; adminDir: string | null }> {
    const notes: string[] = [];
    const configFailure = this.lastConfigLoadFailure;
    if (configFailure !== null) {
      notes.push(
        `Found config at ${configFailure.path} but it failed to load: ${configFailure.error}. ` +
          `Fix it and call load_config.`,
      );
    }
    if (this.loadedConfigChanged && this.configPath !== null) {
      notes.push(
        `CONFIG_CHANGED: ${this.configPath} changed on disk since it was loaded; call load_config to apply it.`,
      );
    }

    const located = await findEnclosingCheckout(absolutePath, (dir) => this.findConfiguredCloneEntry(dir));
    const worktreeRoot =
      located.found?.worktreeRoot ?? located.skipped[0]?.path ?? located.undetermined?.path ?? absolutePath;

    const unsupported = (
      reason: string,
      capabilities: Capabilities = emptyCapabilities(reason),
    ): { result: DiscoveredRepoContext; adminDir: string | null } => {
      notes.push(reason);
      return {
        result: {
          isWorktree: false,
          kind: "unsupported",
          currentBranch: null,
          currentWorktreePath: worktreeRoot,
          bareRepoPath: null,
          repoUrl: null,
          worktreeDir: null,
          allWorktrees: [],
          siblingRepositories: [],
          configPath: this.configPath,
          repoName: null,
          capabilities,
          notes,
        },
        adminDir: null,
      };
    };

    if (located.found === null) {
      const reason = describeExhaustedWalk(absolutePath, located);
      const decision = located.undetermined === null ? this.selectDefaultRepository() : null;
      const selected = decision?.kind === "selected" ? this.repos.get(decision.repoName) : undefined;
      if (selected) {
        const result = unsupported(reason, this.computeBaseCapabilities(selected));
        notes.push(
          `Path is not inside a checkout; capabilities are those of repository '${selected.name}', ` +
            `which tools act on when repoName is omitted`,
        );
        return result;
      }
      return unsupported(reason);
    }
    for (const skip of located.skipped) {
      notes.push(`Walked past ${skip.reason} at ${skip.path}`);
    }
    if (located.found.kind === "clone-root") {
      return {
        result: await this.buildCloneModeContext(located.found.entry, worktreeRoot, notes),
        adminDir: null,
      };
    }

    const bareRepoPath = await resolveRealPathAsync(located.found.bareRepoPath);
    const adminDir = located.found.adminDir;

    let repoUrl: string | null = null;
    let worktrees: DiscoveredWorktree[];
    let currentBranch: string | null = null;

    try {
      const bareGit = createGitClient(bareRepoPath);

      try {
        const remoteResult = await bareGit.remote(["get-url", "origin"]);
        const urlStr = typeof remoteResult === "string" ? remoteResult.trim() : "";
        repoUrl = urlStr || null;
      } catch {
        notes.push("Could not read remote origin URL");
      }

      const listOutput = await readWorktreeListPorcelain(bareGit);
      worktrees = parseWorktreeList(listOutput, worktreeRoot);
      const current = worktrees.find((w) => w.isCurrent);
      if (current) {
        currentBranch = current.branch;
      }
    } catch (err) {
      const reason = `Failed to read bare repo at ${bareRepoPath}: ${(err as Error).message}`;
      notes.push(reason);
      return {
        result: {
          isWorktree: true,
          kind: "unsupported",
          currentBranch: null,
          currentWorktreePath: worktreeRoot,
          bareRepoPath,
          repoUrl: null,
          worktreeDir: null,
          allWorktrees: [],
          siblingRepositories: [],
          configPath: this.configPath,
          repoName: null,
          capabilities: emptyCapabilities(reason),
          notes,
        },
        adminDir,
      };
    }

    const derivedWorktreeDir = deriveWorktreeDir(worktrees);

    let matchedConfig: RepoEntry | null = null;
    for (const entry of this.repos.values()) {
      if (entry.source === "config" && configPathMatches(entry, "bareRepoDir", bareRepoPath)) {
        matchedConfig = entry;
        break;
      }
    }

    const worktreeDir = matchedConfig ? path.resolve(matchedConfig.config.worktreeDir) : derivedWorktreeDir;
    notes.push(
      worktreeDir === null
        ? `Could not determine worktreeDir from the registered worktrees of ${bareRepoPath}`
        : `worktreeDir resolved to ${worktreeDir}`,
    );

    let entry: RepoEntry | null = null;
    let kind: DiscoveredRepoContext["kind"] = "unmanaged";

    if (matchedConfig) {
      entry = matchedConfig;
      kind = "managed";
    } else if (repoUrl) {
      const detectedKey = `${AUTO_DETECT_PREFIX}${path.basename(bareRepoPath)}@${bareRepoPath}`;
      entry = this.repos.get(detectedKey) ?? null;
      if (entry) {
        if (derivedWorktreeDir !== null && !pathsEqual(entry.config.worktreeDir, derivedWorktreeDir)) {
          entry.config.worktreeDir = derivedWorktreeDir;
          entry.service = undefined;
        }
      } else {
        const syntheticConfig: Config = {
          repoUrl,
          worktreeDir: derivedWorktreeDir ?? path.dirname(worktreeRoot),
          bareRepoDir: bareRepoPath,
          cronSchedule: DEFAULT_CONFIG.CRON_SCHEDULE,
          runOnce: true,
        };
        entry = { name: detectedKey, config: syntheticConfig, source: "detected" };
        this.repos.set(detectedKey, entry);
      }
      entry.worktreeDirUndetermined = derivedWorktreeDir === null;
    }

    const capabilities: Capabilities = entry
      ? this.computeBaseCapabilities(entry)
      : {
          ...emptyCapabilities(NOT_REGISTERED_NO_URL_REASON),
          sync: { available: false, reason: NO_CONFIG_NO_URL_REASON },
          initialize: { available: false, reason: NO_CONFIG_NO_URL_REASON },
        };
    if (repoUrl === null) {
      capabilities.createWorktree = { available: false, reason: NO_REMOTE_URL_REASON };
      capabilities.updateWorktree = { available: false, reason: NO_REMOTE_URL_REASON };
    }
    if (worktreeDir === null) {
      capabilities.createWorktree = { available: false, reason: UNDETERMINED_WORKTREE_DIR_REASON };
      capabilities.updateWorktree = { available: false, reason: UNDETERMINED_WORKTREE_DIR_REASON };
    }

    const repoName = entry?.name ?? null;
    if (entry) {
      this.bootstrapCurrentRepo(entry.name, matchedConfig !== null);
    }

    const siblingRepositories = await this.discoverSiblingRepositories(bareRepoPath);

    const discovered: DiscoveredRepoContext = {
      isWorktree: true,
      kind,
      currentBranch,
      currentWorktreePath: worktreeRoot,
      bareRepoPath,
      repoUrl: repoUrl === null ? null : redactRepoUrl(repoUrl),
      worktreeDir,
      allWorktrees: worktrees,
      siblingRepositories,
      configPath: this.configPath,
      repoName,
      capabilities,
      notes,
    };

    if (entry) {
      entry.discovered = discovered;
    }

    return { result: discovered, adminDir };
  }

  async getService(repoName?: string): Promise<WorktreeSyncService> {
    if (repoName) {
      const explicit = this.selectExplicitRepository(repoName);
      if (explicit.kind !== "selected") {
        throw new Error(this.buildRepoNotFoundError(repoName));
      }
    }

    const name = repoName ?? this.currentRepo;
    if (!name) {
      throw new Error(this.buildNoRepoSelectedError());
    }
    const entry = this.repos.get(name);
    if (!entry) {
      throw new Error(this.buildRepoNotFoundError(name));
    }
    if (!entry.service) {
      const logger = createStderrLogger(entry.name);
      const retry = entry.config.retry;
      entry.service = new WorktreeSyncService({
        ...entry.config,
        ...(retry?.maxAttempts === "unlimited"
          ? { retry: { ...retry, maxAttempts: DEFAULT_CONFIG.RETRY.MAX_ATTEMPTS } }
          : {}),
        logger,
      });
    }
    return entry.service;
  }

  private getRepositorySelectionState(): RepositorySelectionState {
    const configured = this.getConfiguredRepositoryNames();
    const detected = this.getDetectedRepositoryNames();
    return {
      currentRepo: this.currentRepo,
      configured,
      detected,
      defaultDecision: this.selectDefaultRepository(configured, detected),
    };
  }

  private selectExplicitRepository(repoName: string): RepositorySelectionDecision {
    if (this.repos.has(repoName)) {
      return { kind: "selected", repoName, source: "explicit" };
    }
    return {
      kind: "missing",
      configured: this.getConfiguredRepositoryNames(),
      detected: this.getDetectedRepositoryNames(),
      reason: `Repository '${repoName}' not found`,
    };
  }

  private selectDefaultRepository(
    configured = this.getConfiguredRepositoryNames(),
    detected = this.getDetectedRepositoryNames(),
  ): RepositorySelectionDecision {
    if (this.currentRepo !== null) {
      return { kind: "selected", repoName: this.currentRepo, source: "current" };
    }
    if (this.canAutoSelectSingleConfig(configured, detected)) {
      return { kind: "selected", repoName: configured[0], source: "single-config" };
    }
    if (configured.length === 0 && detected.length === 0) {
      return {
        kind: "missing",
        configured,
        detected,
        reason: "no configured or detected repositories are registered",
      };
    }
    return {
      kind: "ambiguous",
      configured,
      detected,
      reason: "repository selection is ambiguous without currentRepo or explicit repoName",
    };
  }

  private canAutoSelectSingleConfig(
    configured = this.getConfiguredRepositoryNames(),
    detected = this.getDetectedRepositoryNames(),
  ): boolean {
    return this.currentRepo === null && configured.length === 1 && detected.length === 0;
  }

  private getDetectedRepositoryNames(): string[] {
    return Array.from(this.repos.values())
      .filter((entry) => entry.source === "detected")
      .map((entry) => entry.name);
  }

  private formatDetectedRepositoryNames(): string[] {
    return Array.from(this.repos.values())
      .filter((e) => e.source === "detected")
      .map((e) => {
        const location = e.discovered?.currentWorktreePath ?? e.config.bareRepoDir ?? e.config.worktreeDir;
        return location ? `${e.name} (${location})` : e.name;
      });
  }

  private formatKnownRepositoryNames(names: string[]): string {
    return names.length === 0 ? "[]" : `[${names.join(", ")}]`;
  }

  private buildNoRepoSelectedError(): string {
    const selection = this.getRepositorySelectionState();
    const detected = this.formatDetectedRepositoryNames();
    const parts = [
      "No repository specified and no current repository set.",
      `launchCwd=${this.launchCwd}`,
      `configPath=${this.configPath ?? "none"}`,
      `loadedRepos=${this.repos.size} (config: ${selection.configured.length}, detected: ${selection.detected.length})`,
    ];
    if (detected.length > 0) {
      parts.push(`Detected repos: ${this.formatKnownRepositoryNames(detected)}.`);
    }
    if (selection.configured.length > 0) {
      parts.push(`Configured repos: ${this.formatKnownRepositoryNames(selection.configured)}.`);
    }
    if (selection.configured.length > 0 || detected.length > 0) {
      parts.push("Recovery: call set_current_repository with one of the repo names above or pass repoName explicitly.");
    } else {
      parts.push(
        "Recovery: call detect_context {path: <workspace>}, load_config {configPath: <file>}, or pass repoName explicitly.",
      );
    }
    return parts.join(" ");
  }

  private buildRepoNotFoundError(name: string): string {
    const known = Array.from(this.repos.keys());
    const knownStr = this.formatKnownRepositoryNames(known);
    return `Repository '${name}' not found. Known repos: ${knownStr}. Run load_config or detect_context to register it.`;
  }

  getEntry(repoName?: string): RepoEntry | null {
    const name = repoName ?? this.currentRepo;
    if (!name) return null;
    return this.repos.get(name) ?? null;
  }

  getDiscoveredContext(repoName?: string): DiscoveredRepoContext | null {
    const entry = this.getEntry(repoName);
    return entry?.discovered ?? null;
  }

  getBaseCapabilities(repoName?: string): Capabilities | null {
    const entry = this.getEntry(repoName);
    return entry ? this.computeBaseCapabilities(entry) : null;
  }

  private computeBaseCapabilities(entry: RepoEntry): Capabilities {
    const worktreeMutation = (): CapabilityState => {
      if (resolveMode(entry.config) === REPOSITORY_MODES.CLONE) {
        return { available: false, reason: CLONE_MODE_REASON };
      }
      if (entry.worktreeDirUndetermined) {
        return { available: false, reason: UNDETERMINED_WORKTREE_DIR_REASON };
      }
      return entry.config.repoUrl ? { available: true } : { available: false, reason: NO_REMOTE_URL_REASON };
    };
    const configDriven = (): CapabilityState =>
      entry.source === "config" ? { available: true } : { available: false, reason: this.describeUnconfiguredReason() };

    return {
      listWorktrees: { available: true },
      getStatus: { available: true },
      createWorktree: worktreeMutation(),
      updateWorktree: worktreeMutation(),
      sync: configDriven(),
      initialize: configDriven(),
    };
  }

  private describeUnconfiguredReason(): string {
    if (this.configPath === null) {
      return `no config file loaded (running in auto-detect mode); ${CONFIG_RECOVERY_HINT}`;
    }
    return `repository is not listed in the loaded config ${this.configPath}; ${CONFIG_RECOVERY_HINT}`;
  }

  getCurrentRepo(): string | null {
    return this.currentRepo;
  }

  setCurrentRepo(repoName: string): void {
    if (!this.repos.has(repoName)) {
      throw new Error(`Repository '${repoName}' not found`);
    }
    this.currentRepo = repoName;
  }

  getRepositoryList(): Array<{
    name: string;
    repoUrl: string;
    worktreeDir: string | null;
    source: "config" | "detected";
  }> {
    return Array.from(this.repos.values()).map((e) => ({
      name: e.name,
      repoUrl: redactRepoUrl(e.config.repoUrl),
      worktreeDir: e.worktreeDirUndetermined ? null : e.config.worktreeDir,
      source: e.source,
    }));
  }

  getConfiguredRepositoryNames(): string[] {
    return Array.from(this.repos.values())
      .filter((entry) => entry.source === "config")
      .map((entry) => entry.name);
  }

  async getConfiguredRepositorySummaries(options: { detailed?: boolean } = {}): Promise<ConfiguredRepositorySummary[]> {
    const entries = Array.from(this.repos.values()).filter((entry) => entry.source === "config");
    const currentRepo = this.currentRepo;

    const buildLean = (entry: RepoEntry): ConfiguredRepositorySummary => {
      const mode = resolveMode(entry.config);
      const isCurrent = entry.name === currentRepo;
      if (mode === REPOSITORY_MODES.CLONE) {
        return { name: entry.name, mode: "clone", checkoutPath: path.resolve(entry.config.worktreeDir), isCurrent };
      }
      return { name: entry.name, mode: "worktree", worktreeDir: path.resolve(entry.config.worktreeDir), isCurrent };
    };

    if (!options.detailed) {
      return entries.map(buildLean);
    }

    const limit = pLimit(DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS);
    return Promise.all(
      entries.map((entry) =>
        limit(async () => {
          const summary = buildLean(entry);
          summary.repoUrl = redactRepoUrl(entry.config.repoUrl);
          if (entry.config.branch) summary.branch = entry.config.branch;
          if (entry.config.sparseCheckout) {
            const sc = entry.config.sparseCheckout;
            summary.sparseCheckout = {
              ...sc,
              include: [...sc.include],
              ...(sc.exclude ? { exclude: [...sc.exclude] } : {}),
            };
          }

          if (summary.mode === "clone") {
            summary.localReady = await isGitCheckout(summary.checkoutPath);
            return summary;
          }

          if (entry.config.bareRepoDir) {
            summary.bareRepoDir = path.resolve(entry.config.bareRepoDir);
            summary.localReady = await pathExists(path.join(summary.bareRepoDir, "HEAD"));
          } else {
            summary.localReady = false;
          }
          return summary;
        }),
      ),
    );
  }

  autoSelectCurrentRepoIfSingleConfig(): string | null {
    const decision = this.selectDefaultRepository();
    if (decision.kind !== "selected") return null;
    if (decision.source === "single-config") {
      this.currentRepo = decision.repoName;
    }
    return this.currentRepo;
  }

  async getAllConfiguredWorktreeDetails(
    currentWorktreePath: string | null = null,
  ): Promise<{ worktreesByRepo: Record<string, DiscoveredWorktree[]>; errorsByRepo: Record<string, string> }> {
    const entries = Array.from(this.repos.values()).filter((entry) => entry.source === "config");
    const results = await Promise.all(
      entries.map(async (entry) => ({
        name: entry.name,
        result: await this.readConfiguredWorktrees(entry, currentWorktreePath),
      })),
    );

    const worktreesByRepo: Record<string, DiscoveredWorktree[]> = {};
    const errorsByRepo: Record<string, string> = {};

    for (const entry of results) {
      worktreesByRepo[entry.name] = entry.result.worktrees;
      if (entry.result.error) {
        errorsByRepo[entry.name] = entry.result.error;
      }
    }

    return { worktreesByRepo, errorsByRepo };
  }

  getConfigPath(): string | null {
    return this.configPath;
  }

  private async readConfiguredWorktrees(
    entry: RepoEntry,
    currentWorktreePath: string | null,
  ): Promise<{ worktrees: DiscoveredWorktree[]; error?: string }> {
    if (entry.source === "config" && resolveMode(entry.config) === REPOSITORY_MODES.CLONE) {
      return this.readConfiguredCloneWorktree(entry, currentWorktreePath);
    }

    if (entry.source !== "config" || !entry.config.bareRepoDir) return { worktrees: [] };

    const bareRepoPath = path.resolve(entry.config.bareRepoDir);
    if (!(await isDirectory(bareRepoPath))) return { worktrees: [] };

    try {
      const output = await readWorktreeListPorcelain(createGitClient(bareRepoPath));
      return { worktrees: parseWorktreeList(output, currentWorktreePath) };
    } catch (err) {
      return { worktrees: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  private findConfiguredCloneEntry(worktreeRoot: string): RepoEntry | null {
    for (const entry of this.repos.values()) {
      if (entry.source !== "config" || resolveMode(entry.config) !== REPOSITORY_MODES.CLONE) continue;
      if (configPathMatches(entry, "worktreeDir", worktreeRoot)) {
        return entry;
      }
    }
    return null;
  }

  private async buildCloneModeContext(
    entry: RepoEntry,
    worktreeRoot: string,
    notes: string[],
  ): Promise<DiscoveredRepoContext> {
    const resolvedRoot = path.resolve(worktreeRoot);
    let currentBranch: string | null = null;
    try {
      currentBranch = await readCurrentBranch(resolvedRoot);
    } catch (err) {
      notes.push(`Could not read clone-mode branch: ${err instanceof Error ? err.message : String(err)}`);
    }

    const branch = currentBranch ?? "unknown";
    const capabilities = this.computeBaseCapabilities(entry);

    const discovered: DiscoveredRepoContext = {
      isWorktree: true,
      kind: "managed",
      currentBranch,
      currentWorktreePath: resolvedRoot,
      bareRepoPath: null,
      repoUrl: redactRepoUrl(entry.config.repoUrl),
      worktreeDir: resolvedRoot,
      allWorktrees: [{ path: resolvedRoot, branch, isCurrent: true }],
      siblingRepositories: [],
      configPath: this.configPath,
      repoName: entry.name,
      capabilities,
      notes,
    };

    entry.discovered = discovered;
    this.bootstrapCurrentRepo(entry.name, true);
    return discovered;
  }

  private async readConfiguredCloneWorktree(
    entry: RepoEntry,
    currentWorktreePath: string | null,
  ): Promise<{ worktrees: DiscoveredWorktree[]; error?: string }> {
    const worktreePath = path.resolve(entry.config.worktreeDir);
    if (!(await isDirectory(worktreePath)) || !(await hasGitMetadata(worktreePath))) {
      return { worktrees: [] };
    }

    try {
      const branch = await readCurrentBranch(worktreePath);
      return {
        worktrees: [
          {
            path: worktreePath,
            branch,
            isCurrent: currentWorktreePath !== null && configPathMatches(entry, "worktreeDir", currentWorktreePath),
          },
        ],
      };
    } catch (err) {
      return { worktrees: [], error: err instanceof Error ? err.message : String(err) };
    }
  }
}

const pathResolution = new PathResolutionService();

async function realRepoPaths(config: Config): Promise<NonNullable<RepoEntry["realPaths"]>> {
  const [bareRepoDir, worktreeDir] = await Promise.all([
    config.bareRepoDir ? resolveRealPathAsync(config.bareRepoDir) : null,
    resolveRealPathAsync(config.worktreeDir),
  ]);
  return { bareRepoDir, worktreeDir };
}

function configPathMatches(entry: RepoEntry, key: "bareRepoDir" | "worktreeDir", target: string): boolean {
  const configured = entry.config[key];
  if (!configured) return false;
  if (pathsEqual(configured, target)) return true;
  const real = entry.realPaths?.[key];
  return !!real && pathsEqual(real, target);
}

function worktreeDirCandidate(worktree: DiscoveredWorktree): string | null {
  const resolved = path.resolve(worktree.path);
  const flatParent = path.dirname(resolved);
  const flatNames = [
    pathResolution.sanitizeBranchName(worktree.branch),
    pathResolution.plainBranchName(worktree.branch),
  ];
  if (flatNames.some((name) => name !== null && pathsEqual(path.join(flatParent, name), resolved))) {
    return flatParent;
  }
  const segments = worktree.branch.split("/");
  let anchorParent = resolved;
  for (let i = 0; i < segments.length; i++) anchorParent = path.dirname(anchorParent);
  return pathsEqual(path.join(anchorParent, ...segments), resolved) ? anchorParent : null;
}

function deriveWorktreeDir(worktrees: DiscoveredWorktree[]): string | null {
  const votes = new Map<string, { dir: string; count: number }>();
  for (const worktree of worktrees) {
    const candidate = worktreeDirCandidate(worktree);
    if (candidate === null) continue;
    const key = normalizePathForCompare(candidate);
    const tally = votes.get(key);
    if (tally) tally.count += 1;
    else votes.set(key, { dir: candidate, count: 1 });
  }

  let leader: { dir: string; count: number } | null = null;
  let tied = false;
  for (const tally of votes.values()) {
    if (leader === null || tally.count > leader.count) {
      leader = tally;
      tied = false;
    } else if (tally.count === leader.count) {
      tied = true;
    }
  }
  const counted = leader !== null && !tied ? leader.dir : null;

  const probe = worktrees.find((worktree) => worktree.isCurrent);
  const probeCandidate = probe ? worktreeDirCandidate(probe) : null;
  if (probeCandidate === null) return counted;
  if (counted === null) return null;
  return pathsEqual(probeCandidate, counted) ? counted : null;
}

function parseWorktreeList(output: string, currentPath: string | null): DiscoveredWorktree[] {
  const foldedCurrent = currentPath ? normalizePathForCompare(currentPath) : null;
  const results: DiscoveredWorktree[] = [];
  for (const wt of parseWorktreeListPorcelain(output)) {
    const resolved = path.resolve(wt.path);
    const branch = wt.branch ?? (wt.detached ? `(detached ${(wt.head ?? "").slice(0, 7)})` : null);
    if (!branch) continue;
    results.push({
      path: resolved,
      branch,
      isCurrent: foldedCurrent !== null && normalizePathForCompare(resolved) === foldedCurrent,
      ...(wt.prunable && { prunable: true }),
      ...(wt.locked && { locked: true }),
      ...(wt.detached && { detached: true }),
    });
  }
  return results;
}

type EnclosingCheckout =
  | { kind: "worktree"; worktreeRoot: string; bareRepoPath: string; adminDir: string }
  | { kind: "clone-root"; worktreeRoot: string; entry: RepoEntry };

interface SkippedGitDir {
  path: string;
  reason: string;
}

interface CheckoutWalkResult {
  found: EnclosingCheckout | null;
  skipped: SkippedGitDir[];
  undetermined: SkippedGitDir | null;
}

async function configFileFingerprint(filePath: string): Promise<ConfigFingerprint> {
  try {
    const [contents, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
    return { mtimeMs: stat.mtimeMs, contentHash: createHash("sha256").update(contents).digest("hex") };
  } catch {
    return { mtimeMs: null, contentHash: null };
  }
}

async function safeMtimeMs(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(filePath);
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasGitMetadata(worktreePath: string): Promise<boolean> {
  return pathExists(path.join(worktreePath, ".git"));
}

async function isGitCheckout(checkoutPath: string): Promise<boolean> {
  if (!(await isDirectory(checkoutPath))) return false;
  try {
    const inside = (await createGitClient(checkoutPath).raw(["rev-parse", "--is-inside-work-tree"])).trim();
    return inside === "true";
  } catch {
    return false;
  }
}

async function readCurrentBranch(worktreePath: string): Promise<string> {
  const git = createGitClient(worktreePath);
  const branch = (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (branch && branch !== "HEAD") {
    return branch;
  }

  const head = (await git.raw(["rev-parse", "--short", "HEAD"])).trim();
  return head ? `(detached ${head})` : "(detached)";
}

const MAX_ENUMERATED_SKIPS = 5;

function describeSkippedGitDirs(skipped: SkippedGitDir[]): string {
  const shown = skipped.slice(0, MAX_ENUMERATED_SKIPS);
  const remaining = skipped.length - shown.length;
  const listed = shown.map((skip) => `${skip.reason} at ${skip.path}`).join("; ");
  return remaining === 0 ? listed : `${listed}; and ${remaining} more`;
}

function describeExhaustedWalk(absolutePath: string, walk: CheckoutWalkResult): string {
  const walkedPast = walk.skipped.length === 0 ? "" : `; walked past ${describeSkippedGitDirs(walk.skipped)}`;
  if (walk.undetermined !== null) {
    return (
      `Cannot determine whether ${walk.undetermined.path} is a sync-worktrees worktree: ` +
      `${walk.undetermined.reason}. Detection stopped there rather than answer with an enclosing repository` +
      walkedPast
    );
  }
  if (walk.skipped.length === 0) {
    return "No .git file found in path or any parent directory";
  }
  return `No sync-worktrees worktree found in ${absolutePath} or any parent directory${walkedPast}`;
}

function classifyGitFile(
  dir: string,
  gitFileContent: string,
): Extract<EnclosingCheckout, { kind: "worktree" }> | string {
  const gitdirMatch = gitFileContent.match(/^gitdir:\s*(.+)$/m);
  if (!gitdirMatch) {
    return "a nested repository (.git file without a gitdir line)";
  }
  const gitdir = gitdirMatch[1].trim();
  const resolvedGitdir = path.isAbsolute(gitdir) ? gitdir : path.resolve(dir, gitdir);
  const worktreesMatch = resolvedGitdir.match(/^(.+?)[/\\]worktrees[/\\][^/\\]+$/);
  if (!worktreesMatch) {
    return "a nested repository or submodule (gitdir does not point into <bare>/worktrees/<name>)";
  }
  return {
    kind: "worktree",
    worktreeRoot: dir,
    bareRepoPath: path.resolve(worktreesMatch[1]),
    adminDir: path.resolve(resolvedGitdir),
  };
}

async function findEnclosingCheckout(
  startPath: string,
  resolveCloneRoot: (dir: string) => RepoEntry | null,
): Promise<CheckoutWalkResult> {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;
  const skipped: SkippedGitDir[] = [];

  while (true) {
    const gitPath = path.join(current, ".git");
    let gitFileContent: string | null = null;
    let skipReason: string | null = null;
    let unreadableReason: string | null = null;
    try {
      gitFileContent = await fs.readFile(gitPath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EISDIR") {
        skipReason = "a nested repository (.git folder: regular repo, not a sync-worktrees worktree)";
      } else if (code !== "ENOENT") {
        unreadableReason = `an unreadable .git (${code ?? "unknown error"})`;
      }
    }

    if (gitFileContent !== null) {
      const classified = classifyGitFile(current, gitFileContent);
      if (typeof classified !== "string") {
        return { found: classified, skipped, undetermined: null };
      }
      skipReason = classified;
    }

    if (unreadableReason !== null) {
      const cloneEntry = resolveCloneRoot(current);
      if (cloneEntry) {
        return { found: { kind: "clone-root", worktreeRoot: current, entry: cloneEntry }, skipped, undetermined: null };
      }
      return { found: null, skipped, undetermined: { path: current, reason: unreadableReason } };
    }

    if (skipReason !== null) {
      const cloneEntry = resolveCloneRoot(current);
      if (cloneEntry) {
        return { found: { kind: "clone-root", worktreeRoot: current, entry: cloneEntry }, skipped, undetermined: null };
      }
      skipped.push({ path: current, reason: skipReason });
    }

    if (current === root) return { found: null, skipped, undetermined: null };
    const parent = path.dirname(current);
    if (parent === current) return { found: null, skipped, undetermined: null };
    current = parent;
  }
}
