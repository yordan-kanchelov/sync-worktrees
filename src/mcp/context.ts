import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";

import { DEFAULT_CONFIG } from "../constants";
import { ConfigLoaderService } from "../services/config-loader.service";
import { Logger } from "../services/logger.service";
import { WorktreeSyncService } from "../services/worktree-sync.service";
import { parseWorktreeListPorcelain } from "../utils/worktree-list-parser";

import type { Config, RepositoryConfig } from "../types";

export interface Capabilities {
  canListWorktrees: boolean;
  canGetStatus: boolean;
  canCreateWorktree: boolean;
  canRemoveWorktree: boolean;
  canUpdateWorktree: boolean;
  canSync: boolean;
  canInitialize: boolean;
}

export interface DiscoveredWorktree {
  path: string;
  branch: string;
  isCurrent: boolean;
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
  configLoaded: boolean;
  repoName: string | null;
  capabilities: Capabilities;
  reasons: string[];
}

interface RepoEntry {
  name: string;
  config: Config;
  source: "config" | "detected";
  service?: WorktreeSyncService;
  discovered?: DiscoveredRepoContext;
}

const AUTO_DETECT_PREFIX = "__auto_detected__:";

const EMPTY_CAPABILITIES: Capabilities = {
  canListWorktrees: false,
  canGetStatus: false,
  canCreateWorktree: false,
  canRemoveWorktree: false,
  canUpdateWorktree: false,
  canSync: false,
  canInitialize: false,
};

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
    const reasons: string[] = [];
    const absolutePath = path.resolve(dirPath);

    const located = await findWorktreeRoot(absolutePath);
    const worktreeRoot = located?.worktreeRoot ?? absolutePath;

    const unsupported = (reason: string, isWorktree = false): DiscoveredRepoContext => {
      reasons.push(reason);
      return {
        isWorktree,
        kind: "unsupported",
        currentBranch: null,
        currentWorktreePath: worktreeRoot,
        bareRepoPath: null,
        repoUrl: null,
        worktreeDir: null,
        allWorktrees: [],
        configLoaded: this.configPath !== null,
        repoName: null,
        capabilities: EMPTY_CAPABILITIES,
        reasons,
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
    const worktreesMatch = gitdir.match(/^(.+?)[/\\]worktrees[/\\][^/\\]+$/);
    if (!worktreesMatch) {
      return unsupported("gitdir does not follow worktree structure (missing /worktrees/<name>)");
    }

    const bareRepoPath = path.resolve(worktreesMatch[1]);

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
        reasons.push("Could not read remote origin URL");
      }

      const listOutput = await bareGit.raw(["worktree", "list", "--porcelain"]);
      worktrees = parseWorktreeList(listOutput, worktreeRoot);
      const current = worktrees.find((w) => w.isCurrent);
      if (current) {
        currentBranch = current.branch;
      }
    } catch (err) {
      reasons.push(`Failed to read bare repo at ${bareRepoPath}: ${(err as Error).message}`);
      return {
        isWorktree: true,
        kind: "unsupported",
        currentBranch: null,
        currentWorktreePath: worktreeRoot,
        bareRepoPath,
        repoUrl: null,
        worktreeDir: null,
        allWorktrees: [],
        configLoaded: this.configPath !== null,
        repoName: null,
        capabilities: EMPTY_CAPABILITIES,
        reasons,
      };
    }

    const worktreeDir = path.dirname(worktreeRoot);

    const capabilities: Capabilities = {
      canListWorktrees: true,
      canGetStatus: true,
      canCreateWorktree: repoUrl !== null,
      canRemoveWorktree: true,
      canUpdateWorktree: true,
      canSync: false,
      canInitialize: false,
    };

    if (!repoUrl) {
      reasons.push("create_worktree unavailable: no remote origin URL detected");
    }

    let matchedConfig: RepoEntry | null = null;
    for (const entry of this.repos.values()) {
      if (entry.source === "config") {
        const entryBare = entry.config.bareRepoDir ? path.resolve(entry.config.bareRepoDir) : null;
        if (entryBare && entryBare === bareRepoPath) {
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
      capabilities.canSync = true;
      capabilities.canInitialize = true;
      this.currentRepo = matchedConfig.name;
    } else if (repoUrl) {
      const syntheticConfig: Config = {
        repoUrl,
        worktreeDir,
        bareRepoDir: bareRepoPath,
        cronSchedule: DEFAULT_CONFIG.CRON_SCHEDULE,
        runOnce: true,
      };
      const detectedKey = `${AUTO_DETECT_PREFIX}${path.basename(bareRepoPath)}@${bareRepoPath}`;
      this.repos.set(detectedKey, {
        name: detectedKey,
        config: syntheticConfig,
        source: "detected",
      });
      repoName = detectedKey;
      this.currentRepo = detectedKey;
      reasons.push("sync/initialize unavailable: no config file loaded (running in auto-detect mode)");
    } else {
      reasons.push("sync/initialize unavailable: no config file and no remote URL");
    }

    const discovered: DiscoveredRepoContext = {
      isWorktree: true,
      kind,
      currentBranch,
      currentWorktreePath: worktreeRoot,
      bareRepoPath,
      repoUrl,
      worktreeDir,
      allWorktrees: worktrees,
      configLoaded: this.configPath !== null,
      repoName,
      capabilities,
      reasons,
    };

    if (repoName) {
      const entry = this.repos.get(repoName);
      if (entry) {
        entry.discovered = discovered;
      }
    }

    return discovered;
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
  const results: DiscoveredWorktree[] = [];
  for (const wt of parseWorktreeListPorcelain(output)) {
    const resolved = path.resolve(wt.path);
    const branch = wt.branch ?? (wt.detached ? `(detached ${(wt.head ?? "").slice(0, 7)})` : null);
    if (!branch) continue;
    results.push({
      path: resolved,
      branch,
      isCurrent: resolved === resolvedCurrent,
    });
  }
  return results;
}

type FindResult =
  | { kind: "worktree-file"; worktreeRoot: string; gitFileContent: string }
  | { kind: "regular-git-dir"; worktreeRoot: string };

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
