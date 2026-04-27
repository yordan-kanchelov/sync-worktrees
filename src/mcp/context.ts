import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";

import { DEFAULT_CONFIG } from "../constants";
import { ConfigLoaderService } from "../services/config-loader.service";
import { Logger } from "../services/logger.service";
import { WorktreeSyncService } from "../services/worktree-sync.service";
import { isCaseInsensitiveFs } from "../utils/path-compare";
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
  siblingRepositories: SiblingRepository[];
  configLoaded: boolean;
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
    configLoaded: false,
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

  async loadConfig(configPath: string): Promise<RepositoryConfig[]> {
    const absolutePath = path.resolve(configPath);
    const configFile = await this.configLoader.loadConfigFile(absolutePath);

    for (const [name, entry] of this.repos) {
      if (entry.source === "config") {
        this.repos.delete(name);
      }
    }

    this.configPath = absolutePath;
    const configDir = path.dirname(absolutePath);
    const globalDefaults = configFile.defaults;

    for (const repo of configFile.repositories) {
      const resolved = this.configLoader.resolveRepositoryConfig(repo, globalDefaults, configDir, configFile.retry);
      this.repos.set(resolved.name, {
        name: resolved.name,
        config: resolved,
        source: "config",
      });
    }

    if (this.currentRepo && !this.repos.has(this.currentRepo)) {
      this.currentRepo = null;
    }

    if (!this.currentRepo && configFile.repositories.length > 0) {
      this.currentRepo = configFile.repositories[0].name;
    }

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
          await this.loadConfig(found);
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
    const repoDir = path.dirname(currentBareRepoPath);
    const workspaceRoot = path.dirname(repoDir);

    if (workspaceRoot === repoDir) return [];

    let entries: string[];
    try {
      entries = await fs.readdir(workspaceRoot);
    } catch {
      return [];
    }

    const fold = (p: string): string => (isCaseInsensitiveFs() ? p.toLowerCase() : p);
    const configBares = new Map<string, string>();
    for (const entry of this.repos.values()) {
      if (entry.source === "config" && entry.config.bareRepoDir) {
        configBares.set(fold(path.resolve(entry.config.bareRepoDir)), entry.name);
      }
    }

    const results: SiblingRepository[] = [];
    await Promise.all(
      entries.map(async (entry) => {
        const candidate = path.join(workspaceRoot, entry);
        const bareCandidate = path.join(candidate, ".bare");
        try {
          const stat = await fs.stat(bareCandidate);
          if (!stat.isDirectory()) return;
        } catch {
          return;
        }

        const resolvedBare = path.resolve(bareCandidate);
        const matchedName = configBares.get(fold(resolvedBare));
        results.push({
          name: matchedName ?? entry,
          bareRepoPath: resolvedBare,
          configMatched: matchedName !== undefined,
        });
      }),
    );

    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
  }

  private bootstrapCurrentRepo(candidate: string): void {
    if (this.currentRepo !== null) return;
    if (!this.repos.has(candidate)) return;
    if (this.repos.size !== 1) return;
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

    const unsupported = (
      reason: string,
      isWorktree = false,
      bareRepoPath: string | null = null,
    ): { result: DiscoveredRepoContext; adminDir: string | null } => {
      notes.push(reason);
      return {
        result: {
          isWorktree,
          kind: "unsupported",
          currentBranch: null,
          currentWorktreePath: worktreeRoot,
          bareRepoPath,
          repoUrl: null,
          worktreeDir: null,
          allWorktrees: [],
          siblingRepositories: [],
          configLoaded: this.configPath !== null,
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
          configLoaded: this.configPath !== null,
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

    const foldPath = (p: string): string => (isCaseInsensitiveFs() ? p.toLowerCase() : p);
    const foldedBare = foldPath(bareRepoPath);
    let matchedConfig: RepoEntry | null = null;
    for (const entry of this.repos.values()) {
      if (entry.source === "config") {
        const entryBare = entry.config.bareRepoDir ? path.resolve(entry.config.bareRepoDir) : null;
        if (entryBare && foldPath(entryBare) === foldedBare) {
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
      this.bootstrapCurrentRepo(repoName);
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
      configLoaded: this.configPath !== null,
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

  getConfigPath(): string | null {
    return this.configPath;
  }
}

function parseWorktreeList(output: string, currentPath: string): DiscoveredWorktree[] {
  const resolvedCurrent = path.resolve(currentPath);
  const fold = (p: string): string => (isCaseInsensitiveFs() ? p.toLowerCase() : p);
  const foldedCurrent = fold(resolvedCurrent);
  const results: DiscoveredWorktree[] = [];
  for (const wt of parseWorktreeListPorcelain(output)) {
    const resolved = path.resolve(wt.path);
    const branch = wt.branch ?? (wt.detached ? `(detached ${(wt.head ?? "").slice(0, 7)})` : null);
    if (!branch) continue;
    results.push({
      path: resolved,
      branch,
      isCurrent: fold(resolved) === foldedCurrent,
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
