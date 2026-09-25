import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import pLimit from "p-limit";

import { DEFAULT_CONFIG, GIT_CONSTANTS } from "../constants";
import { ConfigLoaderService } from "../services/config-loader.service";
import { Logger } from "../services/logger.service";
import { PathResolutionService } from "../services/path-resolution.service";
import { WorktreeSyncService } from "../services/worktree-sync.service";
import { createGitClient } from "../utils/git-client";
import { redactRepoUrl } from "../utils/git-url";
import { normalizePathForCompare, pathsEqual } from "../utils/path-compare";
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

/**
 * Presentation view of a discovered checkout, returned to MCP clients. Every
 * `repoUrl` in it (and in the sibling / configured-repository summaries) is
 * passed through {@link redactRepoUrl}; the working URL stays on the entry's
 * `config`, which is what the services use for git operations.
 */
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
  // Auto-detected entries only: the last detection could not agree on a
  // worktreeDir, so config.worktreeDir holds a placeholder no tool may write
  // under. Durable on the entry rather than only on `discovered`, which
  // invalidateDiscovered() clears while leaving the entry itself in place.
  // (RepoEntry is not exported, but __registerForTest names it, so tsc emits
  // this interface into the .d.ts -- a /** */ comment here would ship too.)
  worktreeDirUndetermined?: boolean;
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

// Identity of the config file that failed to auto-load, as it was on disk at
// the moment of the failure. Both halves are null when the file could not be
// read at all, which the gate treats as "unknown", never as "unchanged".
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
// How many probed paths the discovery cache keeps, least-recently-used first
// out. The cache is keyed by the path detect_context was pointed at and each
// entry holds a whole DiscoveredRepoContext -- including that repository's
// full `allWorktrees` array -- so an unbounded map retained one such array per
// distinct subdirectory a long-lived MCP session ever probed, which for a repo
// with many worktrees is quadratic in the worktree count.
//
// 64 is far above the working set the cache exists for: entries only stay
// usable for DISCOVERY_CACHE_TTL_MS, and the paths a client probes inside a
// five-second window are the one or two it is working in. Eviction cannot
// change an answer either -- a dropped entry is re-detected from disk, exactly
// as a TTL expiry or any mutating tool's invalidateDiscovered() already forces.
const DISCOVERY_CACHE_LIMIT = 64;
const NO_REMOTE_URL_REASON = "no remote origin URL detected";
const NO_CONFIG_NO_URL_REASON = "no config and no remote URL";
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
  // Explicitly stderr-bound: this loader runs inside the stdio server, whose
  // stdout is the JSON-RPC stream. `console.warn` already goes to stderr, so
  // this is belt and braces rather than a fix — it makes the destination a
  // property of this call site instead of a property of `console`.
  private configLoader = new ConfigLoaderService({ logger: createStderrLogger() });
  private discoveryCache = new Map<string, CachedDiscovery>();
  private lastConfigLoadFailure: ConfigLoadFailure | null = null;
  private readonly launchCwd: string;

  constructor(options: { launchCwd?: string } = {}) {
    this.launchCwd = path.resolve(options.launchCwd ?? process.cwd());
  }

  getLaunchCwd(): string {
    return this.launchCwd;
  }

  async findConfigUpward(startDir: string): Promise<string | null> {
    return this.configLoader.findConfigUpward(startDir);
  }

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
        configFile.parallelism,
      );
      resolvedAll.push(resolved);
    }
    this.configLoader.detectPathCollisions(resolvedAll);

    for (const [name, entry] of this.repos) {
      if (entry.source === "config") {
        this.repos.delete(name);
      }
    }

    this.configPath = absolutePath;
    // Reached only past every throw in this method, so it marks a config that
    // is genuinely loaded -- from the auto-load below or from load_config.
    this.lastConfigLoadFailure = null;
    for (const resolved of resolvedAll) {
      this.repos.set(resolved.name, {
        name: resolved.name,
        config: resolved,
        source: "config",
      });
    }

    this.reselectDetectedCurrentRepoIfConfigured();

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
    const absolutePath = path.resolve(dirPath);

    const cached = this.discoveryCache.get(absolutePath);
    if (cached && (await this.isCacheFresh(cached))) {
      // A Map iterates in insertion order, so re-inserting a hit makes it the
      // newest entry and rememberDiscovery evicts the least recently used one.
      this.discoveryCache.delete(absolutePath);
      this.discoveryCache.set(absolutePath, cached);
      return cached.result;
    }

    if (this.configPath === null) {
      const found = await this.configLoader.findConfigUpward(absolutePath);
      if (found === null) {
        this.lastConfigLoadFailure = null;
      } else {
        // Fingerprinted before the attempt, never after: an edit that lands
        // while the import is running must be re-imported next time, and
        // recording the post-failure bytes would pin the repair as "already
        // tried".
        const fingerprint = await configFileFingerprint(found);
        if (this.shouldReimportConfig(found, fingerprint)) {
          try {
            await this.loadConfig(found, { setDefaultCurrent: false });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.lastConfigLoadFailure = { path: found, error: message, ...fingerprint };
            // Kept next to the note rather than replaced by it. The note is for
            // an MCP client; this line is for whoever is tailing the server in a
            // terminal, who never sees tool output. It costs nothing on the wire
            // -- stderr is not the JSON-RPC stream -- and it is now written once
            // per broken revision instead of once per cache miss.
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
    // Caches one detection, dropping the oldest entries past
    // DISCOVERY_CACHE_LIMIT. Written here rather than above the member: esbuild
    // ships a comment that leads a class-body member into the bundle, and drops
    // one that leads a statement in a method body.
    //
    // The leading delete is what makes this least-recently-used rather than
    // first-inserted-first-out: a Map keeps a re-`set` key in its original
    // position, so re-caching a hot path would not move it off the front.
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

  /** @internal Test-only helper — exposes the internal selection state. */
  __getRepositorySelectionStateForTest(): unknown {
    return this.getRepositorySelectionState();
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

  private reselectDetectedCurrentRepoIfConfigured(): void {
    if (!this.currentRepo) return;
    const current = this.repos.get(this.currentRepo);
    if (current?.source !== "detected") return;
    const match = this.findConfiguredEntryForDetected(current);
    if (match) {
      this.currentRepo = match.name;
    }
  }

  private findConfiguredEntryForDetected(detected: RepoEntry): RepoEntry | null {
    const discovered = detected.discovered;
    const detectedBare = discovered?.bareRepoPath ?? detected.config.bareRepoDir ?? null;
    const detectedWorktree = discovered?.currentWorktreePath ?? detected.config.worktreeDir;

    for (const entry of this.repos.values()) {
      if (entry.source !== "config") continue;
      if (
        detectedBare &&
        entry.config.bareRepoDir &&
        normalizePathForCompare(path.resolve(entry.config.bareRepoDir)) ===
          normalizePathForCompare(path.resolve(detectedBare))
      ) {
        return entry;
      }
      if (
        resolveMode(entry.config) === REPOSITORY_MODES.CLONE &&
        normalizePathForCompare(path.resolve(entry.config.worktreeDir)) ===
          normalizePathForCompare(path.resolve(detectedWorktree))
      ) {
        return entry;
      }
    }
    return null;
  }

  private shouldReimportConfig(configPath: string, fingerprint: ConfigFingerprint): boolean {
    const failure = this.lastConfigLoadFailure;
    if (failure === null) return true;
    if (!pathsEqual(failure.path, configPath)) return true;
    // Fail open when either side could not be fingerprinted. An unreadable file
    // must never be mistaken for an unchanged one, or a config nobody can stat
    // is pinned as broken for the life of the process.
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
    // Seeded before any of the branches below so the note survives every shape
    // this returns -- unmanaged, unsupported and clone-mode alike. Without it a
    // found-but-broken config reaches the client as configPath: null with no
    // hint that a config file exists, and the agent's next move is to write a
    // second one.
    const configFailure = this.lastConfigLoadFailure;
    if (configFailure !== null) {
      notes.push(
        `Found config at ${configFailure.path} but it failed to load: ${configFailure.error}. ` +
          `Fix it and call load_config.`,
      );
    }

    const located = await findEnclosingCheckout(absolutePath, (dir) => this.findConfiguredCloneEntry(dir));
    // When the walk found nothing, report the deepest .git it stepped over as
    // the location rather than the probed path: that is the directory the agent
    // is actually standing in a repository of, and it is what this reported
    // before the walk resumed. A .git that could not be read is the shallowest
    // of the three, so it only names the location when nothing was stepped over.
    const worktreeRoot =
      located.found?.worktreeRoot ?? located.skipped[0]?.path ?? located.undetermined?.path ?? absolutePath;

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

    if (located.found === null) {
      // The old message named only the absence of a .git. Saying that after
      // stepping over three nested repositories tells the agent something
      // false, so the exhausted answer enumerates what the walk passed. It is
      // the only note in this case, which is why the per-skip notes below are
      // not also pushed here.
      return unsupported(describeExhaustedWalk(absolutePath, located));
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

    const bareRepoPath = located.found.bareRepoPath;
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

    // A matching config is authoritative: its worktreeDir is the directory the
    // tools will actually write under, so report that rather than anything read
    // back from git. Only an auto-detected repository has to be derived, and
    // only it reports null when the derivation could not agree on an answer.
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
        // Detection re-runs on every cache miss and the registered list can
        // change between runs, so keep the stored entry in step with the value
        // reported here instead of leaving the first run's answer frozen in.
        // getService builds the service from a spread copy of this config, so
        // an already-built one keeps the directory it was born with: drop it
        // too, or detect_context reports the new directory while
        // create_worktree keeps writing under the old one. Both locks a repo
        // operation takes are keyed by paths, not by this object, so a rebuilt
        // service is still serialized against one that is mid-operation.
        if (derivedWorktreeDir !== null && !pathsEqual(entry.config.worktreeDir, derivedWorktreeDir)) {
          entry.config.worktreeDir = derivedWorktreeDir;
          entry.service = undefined;
        }
      } else {
        const syntheticConfig: Config = {
          repoUrl,
          // Only reached when the derivation failed. The read-only tools work
          // off the bare repo and never touch this directory; createWorktree
          // and updateWorktree, the two that would write under it, are marked
          // unavailable below, so nothing is placed on disk from this guess.
          worktreeDir: derivedWorktreeDir ?? path.dirname(worktreeRoot),
          bareRepoDir: bareRepoPath,
          cronSchedule: DEFAULT_CONFIG.CRON_SCHEDULE,
          runOnce: true,
        };
        entry = { name: detectedKey, config: syntheticConfig, source: "detected" };
        this.repos.set(detectedKey, entry);
      }
      // Record the outcome where invalidateDiscovered cannot erase it: that
      // call drops `discovered` but keeps the entry, and ensureCapability
      // stops at the base capabilities when there is no discovery snapshot.
      entry.worktreeDirUndetermined = derivedWorktreeDir === null;
    }

    // Start from the entry's durable capabilities so that discovery can only
    // narrow them, never widen them (see computeBaseCapabilities).
    const capabilities: Capabilities = entry
      ? this.computeBaseCapabilities(entry)
      : {
          listWorktrees: { available: true },
          getStatus: { available: true },
          createWorktree: { available: false, reason: NO_REMOTE_URL_REASON },
          updateWorktree: { available: true },
          sync: { available: false, reason: NO_CONFIG_NO_URL_REASON },
          initialize: { available: false, reason: NO_CONFIG_NO_URL_REASON },
        };
    if (repoUrl === null) {
      // A bare repo without an origin URL cannot create worktrees, even when a
      // loaded config lists one for it.
      capabilities.createWorktree = { available: false, reason: NO_REMOTE_URL_REASON };
    }
    if (worktreeDir === null) {
      // Both tools resolve a target under worktreeDir — createWorktree through
      // getBranchWorktreePath, updateWorktree through the initialize() that
      // rebuilds the default-branch worktree — so neither may run on a guess.
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
      entry.service = new WorktreeSyncService({
        ...entry.config,
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

  /**
   * Capabilities derived from the entry's durable state (source, mode, repoUrl
   * and whether a loaded config lists it) rather than from the discovery
   * cache. Handlers gate on these first: every mutating tool clears the cache,
   * so an empty cache must never re-enable a tool that detection declared
   * unavailable. Returns null when no entry is selected or found.
   */
  getBaseCapabilities(repoName?: string): Capabilities | null {
    const entry = this.getEntry(repoName);
    return entry ? this.computeBaseCapabilities(entry) : null;
  }

  /**
   * Single source of truth for capability decisions. Discovery starts from
   * this map and may only narrow it with facts read from git.
   */
  private computeBaseCapabilities(entry: RepoEntry): Capabilities {
    const worktreeMutation = (): CapabilityState => {
      if (resolveMode(entry.config) === REPOSITORY_MODES.CLONE) {
        return { available: false, reason: CLONE_MODE_REASON };
      }
      // An auto-detected entry whose worktreeDir could not be derived carries a
      // placeholder directory. Both tools resolve their target under it, so the
      // refusal has to be durable rather than live only in the discovery
      // snapshot that every mutating tool — and load_config — clears.
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

  getRepositoryList(): Array<{ name: string; repoUrl: string; worktreeDir: string; source: "config" | "detected" }> {
    return Array.from(this.repos.values()).map((e) => ({
      name: e.name,
      repoUrl: redactRepoUrl(e.config.repoUrl),
      worktreeDir: e.config.worktreeDir,
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
            summary.localReady = await isDirectory(summary.bareRepoDir);
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

const pathResolution = new PathResolutionService();

// Where a registered worktree says its parent directory is, or null when its
// path is not one this tool would have produced.
//
// Two shapes exist and they are not alike. A branch worktree sits at
// getBranchWorktreePath(worktreeDir, branch): one component, the branch name
// flattened and suffixed with a hash of it. The default-branch worktree is the
// exception -- GitService anchors it at the plain join(worktreeDir, branch), so
// a nested name such as `release/2024` contributes two components, which is
// exactly what made dirname() the wrong answer here. Both shapes invert, so a
// candidate parent is rebuilt back into a path and kept only if it reproduces
// the registered one. Only a path matching neither shape abstains outright -- a
// detached entry carrying the pseudo-name `(detached abc1234)`, a directory
// named after neither the branch nor its flattening. The anchor shape is
// `<dir>/<branch>`, so a hand-run `git worktree add ../hotfix hotfix` outside
// worktreeDir is recognized and votes for `../`; deriveWorktreeDir outvotes it
// rather than relying on it to abstain.
function worktreeDirCandidate(worktree: DiscoveredWorktree): string | null {
  const resolved = path.resolve(worktree.path);
  const hashedParent = path.dirname(resolved);
  if (pathsEqual(pathResolution.getBranchWorktreePath(hashedParent, worktree.branch), resolved)) {
    return hashedParent;
  }
  const segments = worktree.branch.split("/");
  let anchorParent = resolved;
  for (let i = 0; i < segments.length; i++) anchorParent = path.dirname(anchorParent);
  return pathsEqual(path.join(anchorParent, ...segments), resolved) ? anchorParent : null;
}

// Two independent signals have to agree, or nothing is answered.
//
// The count decides first. Abstaining entries do not vote, and a minority of
// recognized ones is outvoted rather than allowed to refuse for everyone --
// the anchor shape is `<dir>/<branch>`, so the conventional hand-run
// `git worktree add ../hotfix hotfix` is recognized and would otherwise veto a
// repository whose other entries agree. A tie leaves no answer to prefer.
//
// Then the worktree this detection was run from has to corroborate that count.
// It is the one entry known to be real and relevant, but it is a sample of one
// and an agent is most likely to be standing in exactly the hand-placed
// worktree that disagrees, so it confirms rather than overrides: letting it
// override put a new worktree beside one stray while five tool-made ones said
// otherwise. When it is absent from the list (git stores canonical paths, so a
// symlinked cwd matches none of them) or abstains (a detached entry), the count
// stands alone -- there is nothing to corroborate with, not a reason to refuse.
//
// A single vote still wins: the shape it matched already fixes how many
// components its branch name contributed, which is the fact a probe path cannot
// supply, and there is no second entry to weigh it against.
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

// A found-but-broken config is re-read on every cache-missing detect, and past
// the first failure each read costs a whole worker thread: ConfigLoaderService
// records a path as evaluated *before* it imports it, so even a failed first
// import pushes every later one onto T35's reload path. This fingerprint is
// what lets the gate skip that repeat -- but only while the file is still
// byte-for-byte the one that failed, because a config the user has just fixed
// has to load on the very next detect_context.
//
// mtime alone cannot keep that promise. It is nanosecond-resolution on ext4 and
// APFS but one-second on HFS+ and on most NFS/SMB mounts, and the smallest real
// syntax fix -- one '}' becoming ']' -- leaves the size identical, so a repair
// landing in the same second as the failure is invisible to a stat-only check.
// The hash reads a file of a few KB, once per auto-load attempt. A config that
// loads is fingerprinted exactly once in the life of the process -- `configPath`
// is set from then on and this whole path is skipped -- so a healthy workspace
// pays one read of one file, ever, and never a read per detect. While a config
// is broken it is computed on each attempt, which is exactly where it replaces
// spawning a worker.
//
// Either half changing re-imports, so `touch` alone releases the gate. That is
// the deliberate escape for a fault that lives in a module the config imports
// rather than in the config file: such a SyntaxError names no file at all, in
// the message or the stack, so there is nothing else here to fingerprint. The
// note points at load_config, which does not come through this path.
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

async function hasGitMetadata(worktreePath: string): Promise<boolean> {
  try {
    await fs.stat(path.join(worktreePath, ".git"));
    return true;
  } catch {
    return false;
  }
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

// Every clause of the exhausted reason carries a whole absolute path, and the
// reason is repeated once per capability plus once in the notes, so enumerating
// one clause per level makes the answer grow with the square of the depth: a
// probe under thirty nested repositories produced a 16 KB reason and a 116 KB
// tool result. The deepest few are the ones the agent is standing in; the rest
// are counted.
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
    // Not "no worktree here" -- "cannot tell". Answering with the repository
    // that encloses an unreadable .git would name a different repository than
    // the one the agent is standing in, and every mutating tool would then act
    // on that name.
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
  // Returns the enclosing worktree this .git file points at, or the reason it
  // is not one. A submodule lands on the second branch: its gitdir resolves to
  // <admin>/modules/<name>, which carries a path separator after /worktrees/
  // and so cannot match.
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
  // Walks up from startPath and stops at the first directory that is a shape
  // this tool can act on: a worktree whose gitdir points into
  // <bare>/worktrees/<name>, or a configured clone-mode root. Every other .git
  // on the way -- a vendored `git init`, a submodule, an unreadable one -- is
  // recorded and stepped over rather than answered with, so an agent sitting in
  // a nested repository still learns about the managed worktree above it.
  //
  // A clone-mode root is a terminal answer, not something to step over:
  // resuming past a checkout the config names would trade a real repository
  // for whatever happens to sit further up.
  //
  // A .git that cannot be READ is the one thing the walk may not step over. A
  // .git folder and a gitdir line that points elsewhere are both positive
  // identifications -- git itself would not call either of them a linked
  // worktree -- but an errno says only that this process could not look. Passing
  // it over lets a managed worktree whose own .git is briefly unreadable be
  // answered with the DIFFERENT repository that encloses it, capabilities and
  // all, where the honest answer is "cannot tell". So the walk stops there,
  // unless the config names that very directory as a clone-mode root, which
  // identifies the repository without reading anything.
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
        // One unreadable .git used to abort the walk for the whole tree and
        // then report "No .git file found in path or any parent directory",
        // which is false. It still ends the walk -- see above -- but as its own
        // outcome, carrying the errno and the directory, so the caller can say
        // which .git it could not read instead of claiming there was none.
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
      // The clone lookup runs wherever the walk would otherwise step over
      // something, not only on a .git folder. A clone-mode checkout usually has
      // one, but `git clone --separate-git-dir` leaves a .git *file* holding a
      // gitdir that points nowhere near <bare>/worktrees/<name>, and a checkout
      // whose .git cannot be read at all is still the configured repository the
      // config names. Ruling out the worktree shape first keeps a .git file
      // that is a real worktree pointer answering as a worktree, as it always
      // has.
      const cloneEntry = resolveCloneRoot(current);
      if (cloneEntry) {
        return { found: { kind: "clone-root", worktreeRoot: current, entry: cloneEntry }, skipped, undetermined: null };
      }
      skipped.push({ path: current, reason: skipReason });
    }

    if (current === root) return { found: null, skipped, undetermined: null };
    const parent = path.dirname(current);
    // path.dirname is its own fixed point at a filesystem root, and on Windows
    // at a UNC share root it is one that `current === root` does not recognise.
    // Both guards stay: without this one the loop would re-probe the same
    // directory forever now that a probe no longer ends it.
    if (parent === current) return { found: null, skipped, undetermined: null };
    current = parent;
  }
}
