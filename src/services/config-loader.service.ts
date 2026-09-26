import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { Worker } from "worker_threads";

import { CONFIG_FILE_NAMES, DEFAULT_CONFIG, GIT_CONSTANTS } from "../constants";
import { ConfigFileNotFoundError, ConfigValidationError, SyncWorktreesError } from "../errors";
import { matchesPattern } from "../utils/branch-filter";
import { fileExists } from "../utils/file-exists";
import { getDefaultBareRepoDir, parseGitUrl, redactRepoUrl, redactSecretsInText } from "../utils/git-url";
import { isPathEqualOrInside, isPathStrictlyInside, normalizePathForCompare, pathsEqual } from "../utils/path-compare";
import { REPOSITORY_MODES } from "../utils/repo-mode";
import { sanitizeNameForPath } from "../utils/sanitize-name";
import { collectUnknownConfigKeys, formatUnknownConfigKey } from "../utils/unknown-config-keys";
import { KNOWN_CONFIG_KEYS, validateConfigFile } from "./config-schema";

import type { Logger } from "./logger.service";
import type { Config, ConfigFile, RepositoryConfig, RepositoryMode } from "../types";

// Validation lives in the config schema; these are re-exported for the
// callers that have always imported them from here.
export { CLONE_MODE_CONFLICTING_FIELDS, computeParallelismPeak } from "./config-schema";
export type { ParallelismPeak } from "./config-schema";

const require = createRequire(import.meta.url);

/**
 * A config written in ESM but parsed as CommonJS (a `.cjs` target, or a `.js`
 * one whose nearest package.json says `"type": "commonjs"`) surfaces only as a
 * bare `SyntaxError: Unexpected token 'export'`, which names neither the file
 * nor the fix. Appended to — never substituted for — the original message.
 */
function moduleSyntaxHint(absolutePath: string, error: unknown): string {
  if ((error as Error | null)?.name !== "SyntaxError") return "";
  if (!/Unexpected token '?export'?/.test((error as Error).message)) return "";
  return (
    ` (hint: '${path.basename(absolutePath)}' uses ESM syntax but Node parsed it as CommonJS — ` +
    `add "type": "module" to the nearest package.json, or use .mjs/.cjs; a .cjs config must use module.exports)`
  );
}

/**
 * A `.ts` config is run by Node itself, which *erases* type annotations rather
 * than compiling them: syntax that would have to emit code — `enum`,
 * `namespace`, a parameter property, a decorator — is refused outright, with
 * `code: "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX"` and a message about "strip-only
 * mode" that explains neither why nor what to do instead. Keyed on the code
 * rather than the text so the wording of Node's message is not load bearing,
 * and it survives the reload path too: `workerEvalError` carries `code` back
 * across the worker boundary. Appended to — never substituted for — the
 * original message, which names the construct and the line.
 *
 * Not restricted to `.ts` paths on purpose: a `.js` config that imports a `.ts`
 * sibling raises the same code from the sibling, and the same advice holds.
 */
function typeStrippingHint(error: unknown): string {
  if ((error as { code?: unknown } | null)?.code !== "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") return "";
  return (
    ` (hint: Node runs TypeScript by erasing type annotations, so syntax that emits code cannot run. ` +
    `Rewrite it in erasable syntax — a plain object, a union of string literals, 'as const' — or use a .js/.mjs config)`
  );
}

/**
 * An ESM frame names the module by URL. `fileURLToPath` is what turns that back
 * into something the person can open: it un-escapes the path and, because it
 * reads only the pathname, it drops the `?t=` cache-buster `importConfigModule`
 * appends — which otherwise travels into the frame. CommonJS frames are already
 * plain paths.
 */
function sourcePathFromFrame(file: string): string {
  if (!file.startsWith("file://")) return file;
  try {
    return fileURLToPath(file);
  } catch {
    return file;
  }
}

/**
 * Node's decoration of a CommonJS compile failure: the resolved filename and a
 * line, alone on the stack's first line. Anchored on an absolute path — a drive
 * letter, a separator, or a UNC root — because that is what `module.filename`
 * always is, and because the alternative first line is `Name: message`, which
 * can end in `:<digits>` too. Everything between is taken as the path, so a
 * directory with a space or a bracket in its name still parses.
 */
const CJS_COMPILE_DECORATION = /^((?:[A-Za-z]:[\\/]|[/\\]).*):(\d+)$/;

/**
 * One stack frame, split into what it says about *where*. The parenthesised
 * form (`at fn (<location>)`) is tried first and opens at the frame's *first*
 * `(`, not its last: a path such as `/home/me/proj (old)/config.cjs` contains
 * brackets of its own, and a greedy match hands back `old)/config.cjs`. The
 * bare form (`at <location>`, optionally `at async <location>`) is the rest.
 */
const STACK_FRAME = /^\s+at (?:.*?\((.*)\)|(?:async )?(.*))$/;

/** `<file>:<line>:<column>`, split at the last two colons so the file may hold any others. */
const FRAME_POSITION = /^(.*):(\d+):(\d+)$/;

/**
 * Where evaluating a config actually went wrong, as `file:line[:col]`, read out
 * of the error's stack. Empty when the stack names no position.
 *
 * Two shapes, both measured identically on Node 20, 22 and 24. A CommonJS
 * compile failure arrives already decorated: Node prepends `<file>:<line>`, the
 * offending source line and a caret *ahead of* the `SyntaxError:` header, and
 * that prefix is the only place the position appears. Anything thrown while a
 * module evaluates — a `ReferenceError` in the config, a throw from a module it
 * imports — carries an ordinary frame instead, and the first frame outside
 * Node's own internals is it.
 *
 * A module that fails to *parse* under the ESM loader carries neither: V8 keeps
 * that position on its message object, which Node prints when the exception is
 * fatal and discards once it is caught. Those report the file alone, on every
 * Node version tested.
 */
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
    // `node:` is Node's own code and `data:` is the reload worker's bootstrap —
    // CONFIG_EVAL_WORKER_SOURCE, percent-encoded into a URL a whole screen wide.
    // Reporting either as the place to look would be worse than saying nothing.
    if (!position || position[1].startsWith("node:") || position[1].startsWith("data:")) continue;
    return `${sourcePathFromFrame(position[1])}:${position[2]}:${position[3]}`;
  }
  return "";
}

/**
 * Names the file a load failure came from, so `Unexpected token ']'` stops
 * being the whole report. The position is appended when the stack carries one,
 * and the config path is named either way — an error thrown by a module the
 * config imports points somewhere else entirely, and both halves matter then.
 */
function configErrorLocation(absolutePath: string, error: unknown): string {
  const position = stackPosition(error);
  if (position === "") return ` (${absolutePath})`;
  return position.startsWith(`${absolutePath}:`) ? ` (${position})` : ` (${absolutePath}, at ${position})`;
}

/**
 * Config paths this *process* has already evaluated in its own module
 * registry — the state that makes a second load of the same path a *reload*.
 *
 * It is module-level rather than per-instance on purpose, and that is load
 * bearing rather than tidiness: the thing being tracked is Node's registry,
 * which is per process, while `ConfigLoaderService` is not. `handleReload`
 * constructs a brand new loader on every `r`, and so does every CLI command,
 * so a per-instance Set would see a first load every single time and reload
 * in-process — which is the exact staleness this whole path exists to remove.
 * (`RepositoryContext` is the one holder of a long-lived loader, so it alone
 * would have worked either way.) Pinned by "a reload through a second
 * ConfigLoaderService still re-reads an imported module" in
 * config-loader.esm-reload.test.ts.
 */
const configPathsEvaluatedInProcess = new Set<string>();

/**
 * Bootstrap for the worker that re-evaluates a config on reload.
 *
 * The point of the worker is its *empty* module registry. Appending `?t=` to
 * the config's own URL — which is all an in-process reload can do — busts the
 * config file and nothing else: the modules it pulls in with `import`,
 * `await import()` or `createRequire()` keep their original specifiers, stay
 * in the registry, and hand back the exports they were first evaluated with.
 * A worker thread starts with its own registry, so the whole transitive graph
 * is read from disk again. (It also un-breaks a `.js` config that resolves as
 * CommonJS: Node's ESM→CJS bridge ignores the query string entirely, so those
 * did not reload even at the top level.)
 *
 * Carried to the worker as a `data:` URL rather than `{ eval: true }`, which
 * would make the module system of this snippet depend on where the process
 * was started: an eval'd worker is classified like `node -e`, so running
 * sync-worktrees from a directory whose package.json says `"type": "module"`
 * turned a `require` here into "require is not defined in ES module scope".
 * A `data:text/javascript` URL is always a module, on every Node version and
 * from every working directory.
 */
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

/**
 * The exported value crosses back on the structured clone algorithm, not
 * `JSON.stringify`, so `undefined` (distinct from an absent key, which
 * `resolveRepositoryConfig` treats differently), `NaN`, `Infinity`, `-0`,
 * `Date`, `RegExp`, `BigInt`, `Map` and `Set` all survive intact. What does
 * not survive is anything structured clone refuses — a function, a symbol, a
 * `WeakMap`, a `Proxy` — and class instances arrive as plain objects. No field
 * of the public config surface is function-valued (`hooks.onBranchCreated`,
 * `branchInclude` and `branchExclude` are all `string[]`), so this is reported
 * as an error rather than papered over: a silent fallback here would hand back
 * the stale config this whole path exists to avoid.
 */
function workerEvalError(result: Extract<ConfigEvalResult, { ok: false }>, absolutePath: string): Error {
  if (result.uncloneable) {
    return new Error(
      `reloading '${path.basename(absolutePath)}' re-evaluates it in a worker thread so that the modules it imports ` +
        `are read again, and its exported value could not be transferred out of that thread: ${result.message} ` +
        `Export plain data (strings, numbers, booleans, arrays, objects) from a config file`,
    );
  }
  // Rebuilt rather than re-thrown: an Error does not cross a thread boundary
  // as itself. `name` is carried over because `moduleSyntaxHint` keys off it.
  const error = new Error(result.message) as Error & { code?: string };
  error.name = result.name;
  if (result.stack) error.stack = result.stack;
  if (result.code) error.code = result.code;
  return error;
}

/**
 * How long a reload may spend evaluating a config before it is abandoned. A
 * config that awaits something which never settles while holding a live handle
 * (a timer, a socket) would otherwise hang the reload for good — `r` in the
 * dashboard and `load_config` over MCP both wait on it. Node's own detector
 * only catches the handle-free case.
 */
export const CONFIG_RELOAD_TIMEOUT_MS = 30_000;

/** Built without stack frames: the loader's own frames are no place to send someone fixing a config. */
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
      // `argv` travels in workerData, not in the Worker's own `argv` option:
      // a config that branches on CLI flags must read exactly the argv it read
      // when it was evaluated on the main thread, and the option can only
      // append to an array the worker built for itself.
      workerData: { configPath: absolutePath, token: Date.now(), argv: process.argv },
    });

    let settled = false;
    const settle = (deliver: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      deliver();
    };
    // terminate() stops the thread even mid-loop, so the timeout also frees
    // whatever the config was holding.
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

  /**
   * `logger` is the sink for the loader's warnings, and only those; unset it falls through to `console.warn`.
   * Both are stderr. `reloadTimeoutMs` bounds a reload's evaluation (see {@link CONFIG_RELOAD_TIMEOUT_MS}).
   */
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

  async findConfigUpward(startDir: string): Promise<string | null> {
    let current = path.resolve(startDir);
    const root = path.parse(current).root;

    while (true) {
      for (const name of CONFIG_FILE_NAMES) {
        const candidate = path.join(current, name);
        if (await fileExists(candidate)) {
          return candidate;
        }
      }
      if (current === root) return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
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
      // Only a failure from evaluating the file is located. Past that point the
      // stack's first frame is this loader's own, and pointing the person at
      // sync-worktrees' code for a config they have to fix is worse than saying
      // nothing; those messages already name the offending field.
      const where = evaluated ? "" : configErrorLocation(absolutePath, error);
      throw new Error(
        `Failed to load config file: ${(error as Error).message}${where}` +
          `${moduleSyntaxHint(absolutePath, error)}${typeStrippingHint(error)}`,
      );
    }
  }

  /**
   * First evaluation of a path in this process runs on the main thread, which
   * costs nothing and keeps the exported object exactly as the config built it
   * — that is every one-shot CLI run, every daemon start and every MCP start.
   * Only a *re*-load pays for a worker, because only a reload has a populated
   * module registry to escape: `r` in the TUI and repeat `load_config` calls.
   */
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
  }

  // Everything the schema never looked at. Why it warns rather than rejects,
  // and why once per load is the right number: see the header of
  // utils/unknown-config-keys.ts, which costs no shipped bytes.
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
    const seen = new Map<string, string[]>();
    for (const repo of repositories) {
      const list = seen.get(repo.repoUrl) ?? [];
      list.push(repo.name);
      seen.set(repo.repoUrl, list);
    }
    for (const [url, names] of seen) {
      if (names.length > 1) {
        this.warn(
          `[sync-worktrees] repoUrl '${redactRepoUrl(url)}' appears in multiple entries (${names.join(", ")}). ` +
            `Pin 'bareRepoDir' on duplicate entries to make config reorder-proof.`,
        );
      }
    }
  }

  /**
   * The on-disk directories one repository entry owns, resolved against the
   * config file's directory. Split out of resolveRepositoryConfig so the same
   * derivation — including the `.bare/<name>` fallback for duplicate repoUrls —
   * answers both for the entry being resolved and for each of its siblings.
   */
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
    // The only place a repository *name* is needed rather than a usable remote.
    // `https://git.example.com` — a repository served at a web root — is a URL
    // git clones but cannot be named after, so it is refused here, where the
    // fix is, rather than at the repoUrl check, where refusing it would block a
    // configuration that works.
    // An unparseable repoUrl cannot reach here — the config schema refuses it
    // first — so this checks only for the parse that succeeds without a name,
    // and leaves every other outcome to getDefaultBareRepoDir exactly as before.
    const parsed = parseGitUrl(repo.repoUrl);
    if (parsed && parsed.repoName === null) {
      throw new Error(
        `Repository '${repo.name}' needs an explicit 'bareRepoDir': no directory name can be derived from ` +
          `'${redactSecretsInText(repo.repoUrl)}', which has no repository path segment`,
      );
    }
    return { worktreeDir, bareRepoDir: this.resolvePath(getDefaultBareRepoDir(repo.repoUrl), configDir) };
  }

  /**
   * Every directory the config file hands to a repository, this entry's own
   * included. See Config.__configuredRepoDirs for what reads it.
   *
   * A sibling whose own resolution throws (a name that cannot be made into a
   * path segment) is skipped rather than allowed to fail this entry: the throw
   * still happens, unchanged, when that sibling's turn comes, and until then a
   * missing exclusion is the safer failure than a misattributed error.
   */
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
      } catch {
        // Left to the sibling's own resolveRepositoryConfig call.
      }
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

    // Both modes read these: GitService for the bare clone and every network
    // command, CloneSyncService for the clone and the unshallow. Tested against
    // `undefined` rather than for truthiness, because 0 is a real setting here
    // ("no inactivity kill") and a truthiness test would silently discard it
    // and fall back to the 5/15-minute defaults.
    if (repo.fetchTimeoutMs !== undefined || defaults?.fetchTimeoutMs !== undefined) {
      resolved.fetchTimeoutMs = repo.fetchTimeoutMs ?? defaults?.fetchTimeoutMs;
    }

    if (repo.cloneTimeoutMs !== undefined || defaults?.cloneTimeoutMs !== undefined) {
      resolved.cloneTimeoutMs = repo.cloneTimeoutMs ?? defaults?.cloneTimeoutMs;
    }

    if (repo.retry || defaults?.retry || globalRetry) {
      resolved.retry = {
        ...(globalRetry || {}),
        ...(defaults?.retry || {}),
        ...(repo.retry || {}),
      };
    }

    // Top level, then defaults, then the repository — the same precedence as
    // retry above. Without the top-level layer a `parallelism` block written
    // where the example config shows it (and where `retry` works) reached no
    // repository at all, so per-repo limits silently stayed at their defaults.
    if (repo.parallelism || defaults?.parallelism || globalParallelism) {
      resolved.parallelism = {
        ...(globalParallelism || {}),
        ...(defaults?.parallelism || {}),
        ...(repo.parallelism || {}),
      };
    }

    if (repo.filesToCopyOnBranchCreate || defaults?.filesToCopyOnBranchCreate) {
      resolved.filesToCopyOnBranchCreate = [
        ...(repo.filesToCopyOnBranchCreate ?? defaults?.filesToCopyOnBranchCreate ?? []),
      ];
    }

    if (repo.hooks || defaults?.hooks) {
      resolved.hooks = {
        ...(defaults?.hooks || {}),
        ...(repo.hooks || {}),
      };
    }

    const sparse = repo.sparseCheckout ?? defaults?.sparseCheckout;
    if (sparse) {
      resolved.sparseCheckout = sparse;
    }

    if (repo.maintenance || defaults?.maintenance) {
      resolved.maintenance = {
        ...(defaults?.maintenance || {}),
        ...(repo.maintenance || {}),
      };
    }

    if (repo.trash || defaults?.trash) {
      resolved.trash = {
        ...(defaults?.trash || {}),
        ...(repo.trash || {}),
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
    const firstIndex = all.findIndex((r) => {
      const mode = r.mode ?? defaults?.mode ?? REPOSITORY_MODES.WORKTREE;
      return r.repoUrl === repo.repoUrl && mode === REPOSITORY_MODES.WORKTREE;
    });
    const myIndex = all.indexOf(repo);
    return firstIndex !== -1 && myIndex !== -1 && myIndex !== firstIndex;
  }

  /**
   * Rejects entries whose directories collide across the config: two entries
   * sharing a worktreeDir (either mode) or a bareRepoDir, or one entry's
   * worktreeDir overlapping another entry's bareRepoDir. Each entry's own
   * worktreeDir/bareRepoDir separation is checked in resolveRepositoryConfig;
   * this is the cross-entry check. A worktreeDir nested inside another
   * entry's worktreeDir is allowed but warned about.
   */
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
      throw new ConfigValidationError(
        `Repositories '${a.name}' and '${b.name}' bareRepoDir`,
        `resolve to the same bareRepoDir '${path.resolve(a.bareRepoDir)}'. ` +
          `Set distinct 'bareRepoDir' values for duplicate repoUrl entries.`,
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

  // `worktreeOwner`'s worktreeDir must not sit at or under `bareOwner`'s bare
  // repo (worktrees would land inside git's object store), and `bareOwner`'s
  // bare repo must not sit at or under `worktreeOwner`'s worktreeDir (the
  // sync would treat it as a stale checkout directory).
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

    // `--debug` wins over whatever the config says, for every repository.
    if (overrides?.debug) {
      repositories = repositories.map((repo) => ({ ...repo, debug: true }));
    }

    return { repositories, configFile, configDir };
  }
}
