import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { Worker } from "worker_threads";

import { DEFAULT_CONFIG, GIT_CONSTANTS } from "../constants";
import { ConfigFileNotFoundError, ConfigValidationError, SyncWorktreesError } from "../errors";
import { matchesPattern } from "../utils/branch-filter";
import { fileExists } from "../utils/file-exists";
import {
  getDefaultBareRepoDir,
  normalizeRepoUrlForComparison,
  parseGitUrl,
  redactRepoUrl,
  redactSecretsInText,
} from "../utils/git-url";
import { isPathEqualOrInside, isPathStrictlyInside, normalizePathForCompare, pathsEqual } from "../utils/path-compare";
import { REPOSITORY_MODES } from "../utils/repo-mode";
import { sanitizeNameForPath } from "../utils/sanitize-name";
import { collectUnknownConfigKeys, formatUnknownConfigKey } from "../utils/unknown-config-keys";
import { KNOWN_CONFIG_KEYS, definedOnly, validateConfigFile } from "./config-schema";

import type { Logger } from "./logger.service";
import type { Config, ConfigFile, RepositoryConfig, RepositoryMode } from "../types";

const require = createRequire(import.meta.url);

function moduleSyntaxHint(absolutePath: string, error: unknown): string {
  if ((error as Error | null)?.name !== "SyntaxError") return "";
  if (!/Unexpected token '?export'?/.test((error as Error).message)) return "";
  return (
    ` (hint: '${path.basename(absolutePath)}' uses ESM syntax but Node parsed it as CommonJS — ` +
    `add "type": "module" to the nearest package.json, or use .mjs/.cjs; a .cjs config must use module.exports)`
  );
}

function typeStrippingHint(error: unknown): string {
  if ((error as { code?: unknown } | null)?.code !== "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") return "";
  return (
    ` (hint: Node runs TypeScript by erasing type annotations, so syntax that emits code cannot run. ` +
    `Rewrite it in erasable syntax — a plain object, a union of string literals, 'as const' — or use a .js/.mjs config)`
  );
}

function sourcePathFromFrame(file: string): string {
  if (!file.startsWith("file://")) return file;
  try {
    return fileURLToPath(file);
  } catch {
    return file;
  }
}

const CJS_COMPILE_DECORATION = /^((?:[A-Za-z]:[\\/]|[/\\]).*):(\d+)$/;

const STACK_FRAME = /^\s+at (?:.*?\((.*)\)|(?:async )?(.*))$/;

const FRAME_POSITION = /^(.*):(\d+):(\d+)$/;

function stackPosition(error: unknown): string {
  const stack = (error as { stack?: unknown } | null | undefined)?.stack;
  if (typeof stack !== "string") return "";

  const lines = stack.split("\n");
  const decorated = CJS_COMPILE_DECORATION.exec(lines[0] ?? "");
  if (decorated) return `${decorated[1]}:${decorated[2]}`;

  for (const line of lines) {
    const frame = STACK_FRAME.exec(line);
    if (!frame) continue;
    const position = FRAME_POSITION.exec(frame[1] ?? frame[2] ?? "");
    if (!position || position[1].startsWith("node:") || position[1].startsWith("data:")) continue;
    return `${sourcePathFromFrame(position[1])}:${position[2]}:${position[3]}`;
  }
  return "";
}

function configErrorLocation(absolutePath: string, error: unknown): string {
  const position = stackPosition(error);
  if (position === "") return ` (${absolutePath})`;
  return position.startsWith(`${absolutePath}:`) ? ` (${position})` : ` (${absolutePath}, at ${position})`;
}

const configPathsEvaluatedInProcess = new Set<string>();

const CONFIG_EVAL_WORKER_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

// Assigned rather than passed as the Worker's \`argv\` option, which only
// appends: a \`data:\` URL worker has no script-path slot, so appending
// \`process.argv.slice(2)\` leaves \`process.argv\` one entry short and a config
// reading \`process.argv.slice(2)\` — the idiomatic spelling — sees its first
// flag eaten. Copying the main thread's array verbatim is exact on every Node
// version, whatever layout the option would have produced.
process.argv = workerData.argv;

const describe = (error) => ({
  name: error && error.name ? String(error.name) : "Error",
  message: error && error.message ? String(error.message) : String(error),
  stack: error && error.stack ? String(error.stack) : undefined,
  code: error && typeof error.code === "string" ? error.code : undefined,
});

await (async () => {
  let config;
  try {
    const url = pathToFileURL(workerData.configPath);
    url.searchParams.set("t", String(workerData.token));
    const configModule = await import(url.href);
    config = configModule.default;
  } catch (error) {
    parentPort.postMessage({ ok: false, ...describe(error) });
    return;
  }
  try {
    parentPort.postMessage({ ok: true, config });
  } catch (error) {
    parentPort.postMessage({ ok: false, uncloneable: true, ...describe(error) });
  }
})();
`;

type ConfigEvalResult =
  | { ok: true; config: unknown }
  | { ok: false; uncloneable?: boolean; name: string; message: string; stack?: string; code?: string };

function workerEvalError(result: Extract<ConfigEvalResult, { ok: false }>, absolutePath: string): Error {
  if (result.uncloneable) {
    return new Error(
      `reloading '${path.basename(absolutePath)}' re-evaluates it in a worker thread so that the modules it imports ` +
        `are read again, and its exported value could not be transferred out of that thread: ${result.message} ` +
        `Export plain data (strings, numbers, booleans, arrays, objects) from a config file`,
    );
  }
  const error = new Error(result.message) as Error & { code?: string };
  error.name = result.name;
  if (result.stack) error.stack = result.stack;
  if (result.code) error.code = result.code;
  return error;
}

export const CONFIG_RELOAD_TIMEOUT_MS = 30_000;

function reloadTimeoutError(absolutePath: string, timeoutMs: number): Error {
  const seconds = timeoutMs / 1000;
  const error = new Error(
    `reloading '${path.basename(absolutePath)}' did not finish within ${seconds}s, so it was stopped and the ` +
      `configuration already loaded stays in effect. A config file must finish evaluating on its own: look for a ` +
      `top-level await that never settles or a loop that never ends`,
  );
  error.stack = `${error.name}: ${error.message}`;
  return error;
}

function evaluateConfigInWorker(absolutePath: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(CONFIG_EVAL_WORKER_SOURCE)}`), {
      workerData: { configPath: absolutePath, token: Date.now(), argv: process.argv },
      stdout: true,
    });
    worker.stdout.on("data", (chunk: Buffer) => process.stderr.write(chunk));

    let settled = false;
    const settle = (deliver: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      deliver();
    };
    const timer = setTimeout(() => settle(() => reject(reloadTimeoutError(absolutePath, timeoutMs))), timeoutMs);

    worker.once("message", (result: ConfigEvalResult) => {
      settle(() => {
        if (result.ok) {
          resolve(result.config);
        } else {
          reject(workerEvalError(result, absolutePath));
        }
      });
    });
    worker.once("error", (error: Error) => settle(() => reject(error)));
    worker.once("exit", (code) =>
      settle(() => reject(new Error(`config evaluation worker exited with code ${code} without returning a config`))),
    );
  });
}

export class ConfigLoaderService {
  private readonly logger?: Logger;
  private readonly reloadTimeoutMs: number;

  constructor(options: { logger?: Logger; reloadTimeoutMs?: number } = {}) {
    this.logger = options.logger;
    this.reloadTimeoutMs = options.reloadTimeoutMs ?? CONFIG_RELOAD_TIMEOUT_MS;
  }

  private warn(message: string): void {
    if (this.logger) {
      this.logger.warn(message);
    } else {
      console.warn(message);
    }
  }

  async loadConfigFile(configPath: string): Promise<ConfigFile> {
    const absolutePath = path.resolve(configPath);

    if (!(await fileExists(absolutePath))) {
      throw new ConfigFileNotFoundError(absolutePath);
    }

    let evaluated = false;
    try {
      let config: unknown;
      if (absolutePath.endsWith(".cjs")) {
        this.clearRequireCacheSubtree(absolutePath);
        const configModule = require(absolutePath) as { default?: unknown };
        config = configModule.default ?? configModule;
      } else {
        config = await this.importConfigModule(absolutePath);
      }
      evaluated = true;

      if (!config) {
        throw new Error("Config file must use 'export default' syntax");
      }

      this.validateConfigFile(config);

      return config;
    } catch (error) {
      if (error instanceof SyncWorktreesError) {
        throw error;
      }
      const where = evaluated ? "" : configErrorLocation(absolutePath, error);
      throw new Error(
        `Failed to load config file: ${(error as Error).message}${where}` +
          `${moduleSyntaxHint(absolutePath, error)}${typeStrippingHint(error)}`,
      );
    }
  }

  private async importConfigModule(absolutePath: string): Promise<unknown> {
    if (configPathsEvaluatedInProcess.has(absolutePath)) {
      return evaluateConfigInWorker(absolutePath, this.reloadTimeoutMs);
    }
    configPathsEvaluatedInProcess.add(absolutePath);

    const fileUrl = pathToFileURL(absolutePath);
    fileUrl.searchParams.set("t", Date.now().toString());
    const configModule = (await import(fileUrl.href)) as { default?: unknown };
    return configModule.default;
  }

  private validateConfigFile(config: unknown): asserts config is ConfigFile {
    validateConfigFile(config);
    this.warnOnDuplicateRepoUrls(config.repositories);
    this.warnOnUnknownConfigKeys(config);
    this.warnOnDeprecatedConfigKeys(config);
  }

  private warnOnDeprecatedConfigKeys(config: ConfigFile): void {
    const blocks = [config.parallelism, config.defaults?.parallelism, ...config.repositories.map((r) => r.parallelism)];
    if (blocks.some((block) => block?.maxBranchFetches !== undefined)) {
      this.warn("[sync-worktrees] 'parallelism.maxBranchFetches' is deprecated and has no effect; remove it.");
    }
    for (const repo of config.repositories) {
      if (repo.parallelism?.maxRepositories !== undefined) {
        this.warn(
          `[sync-worktrees] 'parallelism.maxRepositories' in repository '${repo.name}' has no effect on a repository; ` +
            "set it at the top level or under defaults.",
        );
      }
    }
  }

  private warnOnUnknownConfigKeys(config: ConfigFile): void {
    for (const finding of collectUnknownConfigKeys(config as unknown as Record<string, unknown>, KNOWN_CONFIG_KEYS)) {
      this.warn(formatUnknownConfigKey(finding));
    }
  }

  private clearRequireCacheSubtree(configPath: string): void {
    let resolved: string;
    try {
      resolved = require.resolve(configPath);
    } catch {
      resolved = configPath;
    }

    const seen = new Set<string>();
    const visit = (modulePath: string): void => {
      if (seen.has(modulePath)) return;
      seen.add(modulePath);

      const cached = require.cache[modulePath];
      if (!cached) return;

      for (const child of cached.children) {
        visit(child.id);
      }
      delete require.cache[modulePath];
    };

    visit(resolved);
  }

  private warnOnDuplicateRepoUrls(repositories: RepositoryConfig[]): void {
    const seen = new Map<string, { url: string; names: string[] }>();
    for (const repo of repositories) {
      const key = normalizeRepoUrlForComparison(repo.repoUrl);
      const entry = seen.get(key) ?? { url: repo.repoUrl, names: [] };
      entry.names.push(repo.name);
      seen.set(key, entry);
    }
    for (const { url, names } of seen.values()) {
      if (names.length > 1) {
        this.warn(
          `[sync-worktrees] repoUrl '${redactRepoUrl(url)}' appears in multiple entries (${names.join(", ")}). ` +
            `Pin 'bareRepoDir' on duplicate entries to make config reorder-proof.`,
        );
      }
    }
  }

  private resolveRepoDirs(
    repo: RepositoryConfig,
    defaults: Partial<Config> | undefined,
    configDir: string | undefined,
    allRepositories: RepositoryConfig[] | undefined,
  ): { worktreeDir: string; bareRepoDir?: string } {
    const mode: RepositoryMode = repo.mode ?? defaults?.mode ?? REPOSITORY_MODES.WORKTREE;
    const worktreeDir = this.resolvePath(repo.worktreeDir, configDir);

    if (mode === REPOSITORY_MODES.CLONE) {
      return { worktreeDir };
    }
    if (repo.bareRepoDir) {
      return { worktreeDir, bareRepoDir: this.resolvePath(repo.bareRepoDir, configDir) };
    }
    if (allRepositories && this.isDuplicateRepoUrl(repo, allRepositories, defaults)) {
      const sanitized = sanitizeNameForPath(repo.name, `Repository '${repo.name}' name`);
      return { worktreeDir, bareRepoDir: this.resolvePath(`${GIT_CONSTANTS.BARE_DIR_NAME}/${sanitized}`, configDir) };
    }
    const parsed = parseGitUrl(repo.repoUrl);
    if (parsed && parsed.repoName === null) {
      throw new Error(
        `Repository '${repo.name}' needs an explicit 'bareRepoDir': no directory name can be derived from ` +
          `'${redactSecretsInText(repo.repoUrl)}', which has no repository path segment`,
      );
    }
    return { worktreeDir, bareRepoDir: this.resolvePath(getDefaultBareRepoDir(repo.repoUrl), configDir) };
  }

  private collectConfiguredRepoDirs(
    repo: RepositoryConfig,
    ownDirs: { worktreeDir: string; bareRepoDir?: string },
    defaults: Partial<Config> | undefined,
    configDir: string | undefined,
    allRepositories: RepositoryConfig[] | undefined,
  ): string[] {
    const dirs = new Set<string>([ownDirs.worktreeDir]);
    if (ownDirs.bareRepoDir) dirs.add(ownDirs.bareRepoDir);

    for (const sibling of allRepositories ?? []) {
      if (sibling === repo) continue;
      try {
        const siblingDirs = this.resolveRepoDirs(sibling, defaults, configDir, allRepositories);
        dirs.add(siblingDirs.worktreeDir);
        if (siblingDirs.bareRepoDir) dirs.add(siblingDirs.bareRepoDir);
      } catch {}
    }

    return Array.from(dirs);
  }

  resolveRepositoryConfig(
    repo: RepositoryConfig,
    defaults?: Partial<Config>,
    configDir?: string,
    globalRetry?: Config["retry"],
    allRepositories?: RepositoryConfig[],
    globalParallelism?: Config["parallelism"],
  ): RepositoryConfig {
    const mode: RepositoryMode = repo.mode ?? defaults?.mode ?? REPOSITORY_MODES.WORKTREE;

    const ownDirs = this.resolveRepoDirs(repo, defaults, configDir, allRepositories);

    const resolved: RepositoryConfig = {
      name: repo.name,
      repoUrl: repo.repoUrl,
      worktreeDir: ownDirs.worktreeDir,
      cronSchedule: repo.cronSchedule ?? defaults?.cronSchedule ?? DEFAULT_CONFIG.CRON_SCHEDULE,
      runOnce: defaults?.runOnce ?? false,
      debug: repo.debug ?? defaults?.debug,
      mode,
    };

    if (configDir) {
      resolved.__configFileDir = configDir;
    }

    resolved.__configuredRepoDirs = this.collectConfiguredRepoDirs(repo, ownDirs, defaults, configDir, allRepositories);

    if (mode === REPOSITORY_MODES.CLONE) {
      if (repo.branch ?? defaults?.branch) {
        resolved.branch = repo.branch ?? defaults?.branch;
      }
      if (repo.depth !== undefined || defaults?.depth !== undefined) {
        resolved.depth = repo.depth ?? defaults?.depth;
      }
    } else {
      resolved.bareRepoDir = ownDirs.bareRepoDir;

      if (repo.branchMaxAge || defaults?.branchMaxAge) {
        resolved.branchMaxAge = repo.branchMaxAge ?? defaults?.branchMaxAge;
      }

      if (repo.branchInclude || defaults?.branchInclude) {
        resolved.branchInclude = repo.branchInclude ?? defaults?.branchInclude;
      }

      if (repo.branchExclude || defaults?.branchExclude) {
        resolved.branchExclude = repo.branchExclude ?? defaults?.branchExclude;
      }

      if (repo.updateExistingWorktrees !== undefined || defaults?.updateExistingWorktrees !== undefined) {
        resolved.updateExistingWorktrees = repo.updateExistingWorktrees ?? defaults?.updateExistingWorktrees ?? true;
      }
    }

    if (repo.skipLfs !== undefined || defaults?.skipLfs !== undefined) {
      resolved.skipLfs = repo.skipLfs ?? defaults?.skipLfs ?? false;
    }

    if (repo.fetchTimeoutMs !== undefined || defaults?.fetchTimeoutMs !== undefined) {
      resolved.fetchTimeoutMs = repo.fetchTimeoutMs ?? defaults?.fetchTimeoutMs;
    }

    if (repo.cloneTimeoutMs !== undefined || defaults?.cloneTimeoutMs !== undefined) {
      resolved.cloneTimeoutMs = repo.cloneTimeoutMs ?? defaults?.cloneTimeoutMs;
    }

    if (repo.retry || defaults?.retry || globalRetry) {
      resolved.retry = {
        ...definedOnly(globalRetry),
        ...definedOnly(defaults?.retry),
        ...definedOnly(repo.retry),
      };
    }

    if (repo.parallelism || defaults?.parallelism || globalParallelism) {
      resolved.parallelism = {
        ...definedOnly(globalParallelism),
        ...definedOnly(defaults?.parallelism),
        ...definedOnly(repo.parallelism),
      };
    }

    if (repo.filesToCopyOnBranchCreate || defaults?.filesToCopyOnBranchCreate) {
      resolved.filesToCopyOnBranchCreate = [
        ...(repo.filesToCopyOnBranchCreate ?? defaults?.filesToCopyOnBranchCreate ?? []),
      ];
    }

    if (repo.hooks || defaults?.hooks) {
      resolved.hooks = {
        ...definedOnly(defaults?.hooks),
        ...definedOnly(repo.hooks),
      };
    }

    const sparse = repo.sparseCheckout ?? defaults?.sparseCheckout;
    if (sparse) {
      resolved.sparseCheckout = sparse;
    }

    if (repo.maintenance || defaults?.maintenance) {
      resolved.maintenance = {
        ...definedOnly(defaults?.maintenance),
        ...definedOnly(repo.maintenance),
      };
    }

    if (repo.trash || defaults?.trash) {
      resolved.trash = {
        ...definedOnly(defaults?.trash),
        ...definedOnly(repo.trash),
      };
    }

    this.validateWorktreeBareRepoSeparation(resolved);

    return resolved;
  }

  private validateWorktreeBareRepoSeparation(repo: RepositoryConfig): void {
    if (repo.mode === REPOSITORY_MODES.CLONE || !repo.bareRepoDir) return;

    const worktreeDir = normalizePathForCompare(repo.worktreeDir);
    const bareRepoDir = normalizePathForCompare(repo.bareRepoDir);
    const worktreeContainsBare = bareRepoDir === worktreeDir || bareRepoDir.startsWith(worktreeDir + path.sep);
    const bareContainsWorktree = worktreeDir.startsWith(bareRepoDir + path.sep);

    if (worktreeContainsBare || bareContainsWorktree) {
      throw new ConfigValidationError(
        `Repository '${repo.name}' bareRepoDir/worktreeDir`,
        `must not overlap (bareRepoDir: ${repo.bareRepoDir}, worktreeDir: ${repo.worktreeDir})`,
      );
    }
  }

  private isDuplicateRepoUrl(repo: RepositoryConfig, all: RepositoryConfig[], defaults?: Partial<Config>): boolean {
    const url = normalizeRepoUrlForComparison(repo.repoUrl);
    const firstIndex = all.findIndex((r) => {
      const mode = r.mode ?? defaults?.mode ?? REPOSITORY_MODES.WORKTREE;
      return normalizeRepoUrlForComparison(r.repoUrl) === url && mode === REPOSITORY_MODES.WORKTREE;
    });
    const myIndex = all.indexOf(repo);
    return firstIndex !== -1 && myIndex !== -1 && myIndex !== firstIndex;
  }

  detectPathCollisions(repositories: RepositoryConfig[]): void {
    for (let i = 0; i < repositories.length; i++) {
      for (let j = i + 1; j < repositories.length; j++) {
        this.detectPathCollisionBetween(repositories[i], repositories[j]);
      }
    }
  }

  private detectPathCollisionBetween(a: RepositoryConfig, b: RepositoryConfig): void {
    if (pathsEqual(a.worktreeDir, b.worktreeDir)) {
      throw new ConfigValidationError(
        `Repositories '${a.name}' and '${b.name}' worktreeDir`,
        `resolve to the same worktreeDir '${path.resolve(a.worktreeDir)}'. ` +
          `Each repository needs its own worktreeDir; sharing one lets each sync move the other's checkouts to trash.`,
      );
    }

    if (a.bareRepoDir && b.bareRepoDir && pathsEqual(a.bareRepoDir, b.bareRepoDir)) {
      const sameUrl = normalizeRepoUrlForComparison(a.repoUrl) === normalizeRepoUrlForComparison(b.repoUrl);
      throw new ConfigValidationError(
        `Repositories '${a.name}' and '${b.name}' bareRepoDir`,
        `resolve to the same bareRepoDir '${path.resolve(a.bareRepoDir)}'. ` +
          (sameUrl
            ? `Set distinct 'bareRepoDir' values for duplicate repoUrl entries.`
            : `Set 'bareRepoDir' explicitly so each repository gets its own directory.`),
      );
    }

    this.rejectWorktreeBareOverlap(a, b);
    this.rejectWorktreeBareOverlap(b, a);

    if (isPathStrictlyInside(a.worktreeDir, b.worktreeDir)) {
      this.warnOnNestedWorktreeDirs(a, b);
    } else if (isPathStrictlyInside(b.worktreeDir, a.worktreeDir)) {
      this.warnOnNestedWorktreeDirs(b, a);
    }
  }

  private rejectWorktreeBareOverlap(worktreeOwner: RepositoryConfig, bareOwner: RepositoryConfig): void {
    if (!bareOwner.bareRepoDir) return;
    if (
      isPathEqualOrInside(worktreeOwner.worktreeDir, bareOwner.bareRepoDir) ||
      isPathEqualOrInside(bareOwner.bareRepoDir, worktreeOwner.worktreeDir)
    ) {
      throw new ConfigValidationError(
        `Repositories '${worktreeOwner.name}' and '${bareOwner.name}' worktreeDir/bareRepoDir`,
        `must not overlap ('${worktreeOwner.name}' worktreeDir: ${path.resolve(worktreeOwner.worktreeDir)}, ` +
          `'${bareOwner.name}' bareRepoDir: ${path.resolve(bareOwner.bareRepoDir)})`,
      );
    }
  }

  private warnOnNestedWorktreeDirs(inner: RepositoryConfig, outer: RepositoryConfig): void {
    this.warn(
      `[sync-worktrees] worktreeDir '${path.resolve(inner.worktreeDir)}' of repository '${inner.name}' is inside ` +
        `worktreeDir '${path.resolve(outer.worktreeDir)}' of repository '${outer.name}'. ` +
        `A remote branch of '${outer.name}' whose directory name matches would move '${inner.name}' to trash. ` +
        `Give each repository its own worktreeDir.`,
    );
  }

  private resolvePath(inputPath: string, baseDir?: string): string {
    if (path.isAbsolute(inputPath)) {
      return inputPath;
    }

    return path.resolve(baseDir || process.cwd(), inputPath);
  }

  filterRepositories(repositories: RepositoryConfig[], filter?: string): RepositoryConfig[] {
    if (!filter) {
      return repositories;
    }

    const patterns = filter.split(",").map((p) => p.trim());

    return repositories.filter((repo) => {
      return patterns.some((pattern) => matchesPattern(repo.name, pattern));
    });
  }

  async buildRepositories(
    configPath: string,
    overrides?: { filter?: string; debug?: boolean },
  ): Promise<{ repositories: RepositoryConfig[]; configFile: ConfigFile; configDir: string }> {
    const configFile = await this.loadConfigFile(configPath);
    const configDir = path.dirname(path.resolve(configPath));

    let repositories = configFile.repositories.map((repo) =>
      this.resolveRepositoryConfig(
        repo,
        configFile.defaults,
        configDir,
        configFile.retry,
        configFile.repositories,
        configFile.parallelism,
      ),
    );

    this.detectPathCollisions(repositories);

    if (overrides?.filter) {
      repositories = this.filterRepositories(repositories, overrides.filter);
    }

    if (overrides?.debug) {
      repositories = repositories.map((repo) => ({ ...repo, debug: true }));
    }

    return { repositories, configFile, configDir };
  }
}
