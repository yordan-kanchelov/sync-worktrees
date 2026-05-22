import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";

import { DEFAULT_CONFIG, GIT_CONSTANTS } from "../constants";
import { ConfigLoaderService } from "../services/config-loader.service";
import { Logger } from "../services/logger.service";
import { WorktreeSyncService } from "../services/worktree-sync.service";
import { normalizePathForCompare } from "../utils/path-compare";
import { REPOSITORY_MODES, resolveMode } from "../utils/repo-mode";
import { parseWorktreeListPorcelain } from "../utils/worktree-list-parser";

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
  removeWorktree: CapabilityState;
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

function emptyCapabilities(reason?: string): Capabilities {
  const state: CapabilityState = reason ? { available: false, reason } : { available: false };
  return {
    listWorktrees: { ...state },
    getStatus: { ...state },
    createWorktree: { ...state },
    removeWorktree: { ...state },
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
  private configLoader = new ConfigLoaderService();
  private discoveryCache = new Map<string, CachedDiscovery>();

  async loadConfig(configPath: string, options: { setDefaultCurrent?: boolean } = {}): Promise<RepositoryConfig[]> {
    const setDefaultCurrent = options.setDefaultCurrent ?? true;
    const absolutePath = path.resolve(configPath);
    const configFile = await this.configLoader.loadConfigFile(absolutePath);

    const configDir = path.dirname(absolutePath);
    const globalDefaults = configFile.defaults;

    const resolvedAll: RepositoryConfig[] = [];
    for (const repo of configFile.repositories) {
      const resolved = this.configLoader.resolveRepositoryConfig(
        repo,
        globalDefaults,
        configDir,
        configFile.retry,
        configFile.repositories,
      );
      resolvedAll.push(resolved);
    }
    this.configLoader.detectBareRepoDirCollisions(resolvedAll);

    for (const [name, entry] of this.repos) {
      if (entry.source === "config") {
        this.repos.delete(name);
      }
    }

    this.configPath = absolutePath;
    for (const resolved of resolvedAll) {
      this.repos.set(resolved.name, {
        name: resolved.name,
        config: resolved,
        source: "config",
      });
    }

    if (this.currentRepo && !this.repos.has(this.currentRepo)) {
      this.currentRepo = null;
    }

    if (setDefaultCurrent && !this.currentRepo && configFile.repositories.length > 0) {
      this.currentRepo = configFile.repositories[0].name;
    }

    this.discoveryCache.clear();

    return configFile.repositories;
  }

  async detectFromPath(dirPath: string): Promise<DiscoveredRepoContext> {
    const absolutePath = path.resolve(dirPath);

    const cached = this.discoveryCache.get(absolutePath);
    if (cached && (await this.isCacheFresh(cached))) {
      return cached.result;
    }

    if (this.configPath === null) {
      const found = await this.configLoader.findConfigUpward(absolutePath);
      if (found) {
        try {
          await this.loadConfig(found, { setDefaultCurrent: false });
        } catch (err) {
          process.stderr.write(`[sync-worktrees] auto-loaded config failed: ${(err as Error).message}\n`);
        }
      }
    }

    const { result, adminDir } = await this.detectFromPathUncached(absolutePath);

    if (result.isWorktree && result.bareRepoPath && adminDir) {
      const [worktreeHeadMtimeMs, worktreesDirMtimeMs] = await Promise.all([
        safeMtimeMs(path.join(adminDir, "HEAD")),
        safeMtimeMs(path.join(result.bareRepoPath, "worktrees")),
      ]);
      this.discoveryCache.set(absolutePath, {
        result,
        cachedAt: Date.now(),
        worktreeAdminDir: adminDir,
        worktreeHeadMtimeMs,
        worktreesDirMtimeMs,
      });
    }

    return result;
  }

  invalidateDiscovered(): void {
    this.discoveryCache.clear();
  }

  /** @internal Test-only helper — registers a repo entry without going through config loading. */
  __registerForTest(name: string, entry: Omit<RepoEntry, "name">): void {
    this.repos.set(name, { ...entry, name });
  }

  /** @internal Test-only helper — sets the current repo pointer. */
  __setCurrentRepoForTest(name: string | null): void {
    this.currentRepo = name;
  }

  /** @internal Test-only helper — returns the size of the internal repo map. */
  __repoCountForTest(): number {
    return this.repos.size;
  }

  /** @internal Test-only helper — returns the size of the discovery cache. */
  __discoveryCacheSizeForTest(): number {
    return this.discoveryCache.size;
  }

  private async discoverSiblingRepositories(currentBareRepoPath: string): Promise<SiblingRepository[]> {
    const currentBare = normalizePathForCompare(currentBareRepoPath);
    const results = new Map<string, SiblingRepository>();
    const byName = (a: SiblingRepository, b: SiblingRepository): number => a.name.localeCompare(b.name);

    const configCandidates = Array.from(this.repos.values())
      .filter((entry) => entry.source === "config" && !!entry.config.bareRepoDir)
      .map((entry) => {
        const bareRepoPath = path.resolve(entry.config.bareRepoDir as string);
        return { entry, bareRepoPath, foldedBare: normalizePathForCompare(bareRepoPath) };
      })
      .filter((c) => c.foldedBare !== currentBare);

    const configPresence = await Promise.all(configCandidates.map((c) => isDirectory(c.bareRepoPath)));
    configCandidates.forEach(({ entry, bareRepoPath, foldedBare }, i) => {
      const sibling: SiblingRepository = {
        name: entry.name,
        bareRepoPath,
        worktreeDir: path.resolve(entry.config.worktreeDir),
        repoUrl: entry.config.repoUrl,
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
    if (this.currentRepo !== null) return;
    if (!this.repos.has(candidate)) return;
    if (!force && this.repos.size !== 1) return;
    this.currentRepo = candidate;
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

    const located = await findWorktreeRoot(absolutePath);
    const worktreeRoot = located?.worktreeRoot ?? absolutePath;

    const unsupported = (reason: string): { result: DiscoveredRepoContext; adminDir: string | null } => {
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
          capabilities: emptyCapabilities(reason),
          notes,
        },
        adminDir: null,
      };
    };

    if (!located) {
      return unsupported("No .git file found in path or any parent directory");
    }
    if (located.kind === "regular-git-dir") {
      const cloneEntry = this.findConfiguredCloneEntry(worktreeRoot);
      if (cloneEntry) {
        return {
          result: await this.buildCloneModeContext(cloneEntry, worktreeRoot, notes),
          adminDir: null,
        };
      }
      return unsupported("Directory has .git folder (regular repo, not a sync-worktrees worktree)");
    }

    const gitFileContent = located.gitFileContent;

    const gitdirMatch = gitFileContent.match(/^gitdir:\s*(.+)$/m);
    if (!gitdirMatch) {
      return unsupported("Invalid .git file format (missing gitdir line)");
    }

    const gitdir = gitdirMatch[1].trim();
    const resolvedGitdir = path.isAbsolute(gitdir) ? gitdir : path.resolve(worktreeRoot, gitdir);
    const worktreesMatch = resolvedGitdir.match(/^(.+?)[/\\]worktrees[/\\][^/\\]+$/);
    if (!worktreesMatch) {
      return unsupported("gitdir does not follow worktree structure (missing /worktrees/<name>)");
    }

    const bareRepoPath = path.resolve(worktreesMatch[1]);
    const adminDir = path.resolve(resolvedGitdir);

    let repoUrl: string | null = null;
    let worktrees: DiscoveredWorktree[] = [];
    let currentBranch: string | null = null;

    try {
      const bareGit = simpleGit(bareRepoPath);

      try {
        const remoteResult = await bareGit.remote(["get-url", "origin"]);
        const urlStr = typeof remoteResult === "string" ? remoteResult.trim() : "";
        repoUrl = urlStr || null;
      } catch {
        notes.push("Could not read remote origin URL");
      }

      const listOutput = await bareGit.raw(["worktree", "list", "--porcelain"]);
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

    const worktreeDir = path.dirname(worktreeRoot);

    const noUrlReason = "no remote origin URL detected";
    const capabilities: Capabilities = {
      listWorktrees: { available: true },
      getStatus: { available: true },
      createWorktree: repoUrl !== null ? { available: true } : { available: false, reason: noUrlReason },
      removeWorktree: { available: true },
      updateWorktree: { available: true },
      sync: { available: false, reason: "no config and no remote URL" },
      initialize: { available: false, reason: "no config and no remote URL" },
    };

    const foldedBare = normalizePathForCompare(bareRepoPath);
    let matchedConfig: RepoEntry | null = null;
    for (const entry of this.repos.values()) {
      if (entry.source === "config" && entry.config.bareRepoDir) {
        if (normalizePathForCompare(entry.config.bareRepoDir) === foldedBare) {
          matchedConfig = entry;
          break;
        }
      }
    }

    let repoName: string | null = null;
    let kind: DiscoveredRepoContext["kind"] = "unmanaged";

    if (matchedConfig) {
      repoName = matchedConfig.name;
      kind = "managed";
      capabilities.sync = { available: true };
      capabilities.initialize = { available: true };
    } else if (repoUrl) {
      const syntheticConfig: Config = {
        repoUrl,
        worktreeDir,
        bareRepoDir: bareRepoPath,
        cronSchedule: DEFAULT_CONFIG.CRON_SCHEDULE,
        runOnce: true,
      };
      const detectedKey = `${AUTO_DETECT_PREFIX}${path.basename(bareRepoPath)}@${bareRepoPath}`;
      if (!this.repos.has(detectedKey)) {
        this.repos.set(detectedKey, {
          name: detectedKey,
          config: syntheticConfig,
          source: "detected",
        });
      }
      repoName = detectedKey;
      const autoReason = "no config file loaded (running in auto-detect mode)";
      capabilities.sync = { available: false, reason: autoReason };
      capabilities.initialize = { available: false, reason: autoReason };
    }

    if (repoName) {
      this.bootstrapCurrentRepo(repoName, matchedConfig !== null);
    }

    const siblingRepositories = await this.discoverSiblingRepositories(bareRepoPath);

    const discovered: DiscoveredRepoContext = {
      isWorktree: true,
      kind,
      currentBranch,
      currentWorktreePath: worktreeRoot,
      bareRepoPath,
      repoUrl,
      worktreeDir,
      allWorktrees: worktrees,
      siblingRepositories,
      configPath: this.configPath,
      repoName,
      capabilities,
      notes,
    };

    if (repoName) {
      const entry = this.repos.get(repoName);
      if (entry) {
        entry.discovered = discovered;
      }
    }

    return { result: discovered, adminDir };
  }

  async getService(repoName?: string): Promise<WorktreeSyncService> {
    const name = repoName ?? this.currentRepo;
    if (!name) {
      throw new Error("No repository specified and no current repository set");
    }
    const entry = this.repos.get(name);
    if (!entry) {
      throw new Error(`Repository '${name}' not found. Load a config or run detect_context first.`);
    }
    if (!entry.service) {
      const logger = createStderrLogger(entry.name);
      entry.service = new WorktreeSyncService({
        ...entry.config,
        logger,
      });
    }
    return entry.service;
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

  getCurrentRepo(): string | null {
    return this.currentRepo;
  }

  setCurrentRepo(repoName: string): void {
    if (!this.repos.has(repoName)) {
      throw new Error(`Repository '${repoName}' not found`);
    }
    this.currentRepo = repoName;
  }

  getRepositoryList(): Array<{ name: string; repoUrl: string; worktreeDir: string; source: "config" | "detected" }> {
    return Array.from(this.repos.values()).map((e) => ({
      name: e.name,
      repoUrl: e.config.repoUrl,
      worktreeDir: e.config.worktreeDir,
      source: e.source,
    }));
  }

  getConfiguredRepositoryNames(): string[] {
    return Array.from(this.repos.values())
      .filter((entry) => entry.source === "config")
      .map((entry) => entry.name);
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
      const output = await simpleGit(bareRepoPath).raw(["worktree", "list", "--porcelain"]);
      return { worktrees: parseWorktreeList(output, currentWorktreePath) };
    } catch (err) {
      return { worktrees: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  private findConfiguredCloneEntry(worktreeRoot: string): RepoEntry | null {
    const foldedRoot = normalizePathForCompare(path.resolve(worktreeRoot));
    for (const entry of this.repos.values()) {
      if (entry.source !== "config" || resolveMode(entry.config) !== REPOSITORY_MODES.CLONE) continue;
      if (normalizePathForCompare(path.resolve(entry.config.worktreeDir)) === foldedRoot) {
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
    const cloneModeReason = "clone-mode repositories have a single checkout; use sync for clone-mode updates";
    const capabilities: Capabilities = {
      listWorktrees: { available: true },
      getStatus: { available: true },
      createWorktree: { available: false, reason: cloneModeReason },
      removeWorktree: { available: false, reason: cloneModeReason },
      updateWorktree: { available: false, reason: cloneModeReason },
      sync: { available: true },
      initialize: { available: true },
    };

    const discovered: DiscoveredRepoContext = {
      isWorktree: true,
      kind: "managed",
      currentBranch,
      currentWorktreePath: resolvedRoot,
      bareRepoPath: null,
      repoUrl: entry.config.repoUrl,
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
            isCurrent:
              currentWorktreePath !== null &&
              normalizePathForCompare(worktreePath) === normalizePathForCompare(currentWorktreePath),
          },
        ],
      };
    } catch (err) {
      return { worktrees: [], error: err instanceof Error ? err.message : String(err) };
    }
  }
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
    });
  }
  return results;
}

type FindResult =
  | { kind: "worktree-file"; worktreeRoot: string; gitFileContent: string }
  | { kind: "regular-git-dir"; worktreeRoot: string };

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

async function hasGitMetadata(worktreePath: string): Promise<boolean> {
  try {
    await fs.stat(path.join(worktreePath, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function readCurrentBranch(worktreePath: string): Promise<string> {
  const git = simpleGit(worktreePath);
  const branch = (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (branch && branch !== "HEAD") {
    return branch;
  }

  const head = (await git.raw(["rev-parse", "--short", "HEAD"])).trim();
  return head ? `(detached ${head})` : "(detached)";
}

async function findWorktreeRoot(startPath: string): Promise<FindResult | null> {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (true) {
    const gitPath = path.join(current, ".git");
    try {
      const content = await fs.readFile(gitPath, "utf-8");
      return { kind: "worktree-file", worktreeRoot: current, gitFileContent: content };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EISDIR") {
        return { kind: "regular-git-dir", worktreeRoot: current };
      }
      if (code !== "ENOENT") {
        return null;
      }
    }
    if (current === root) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
