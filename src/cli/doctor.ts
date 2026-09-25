import { spawn } from "child_process";
import { constants as fsConstants } from "fs";
import * as fs from "fs/promises";
import * as path from "path";

import pLimit from "p-limit";

import { ConfigFileNotFoundError } from "../errors";
import { ConfigLoaderService } from "../services/config-loader.service";
import { findConfigInCwd } from "../utils/config-generator";
import { formatBytes } from "../utils/disk-space";
import { getErrorMessage } from "../utils/errors";
import { getGitAuthHint } from "../utils/git-auth-error";
import { GIT_LOCALE_ENV } from "../utils/git-client";
import { sanitizeGitEnv } from "../utils/git-env";
import { redactRepoUrl, redactSecretsInText } from "../utils/git-url";
import { getRemovalAuditLogPath, getWorktreeDirLockTarget } from "../utils/lock-path";
import { resolveMode, REPOSITORY_MODES } from "../utils/repo-mode";
import { colorsEnabled } from "../utils/terminal";

import type { RepositoryConfig } from "../types";

/**
 * The Node.js major that package.json `engines.node` names. bin/node-version.js
 * carries the same number for the start-up warning; src/cli/__tests__ keeps the
 * two in step.
 */
export const DOCTOR_MIN_NODE_MAJOR = 24;

/**
 * The oldest git this tool is written against. `git worktree list -z` arrived
 * in 2.36; on an older git the listing falls back to the newline form, which
 * cannot represent a worktree path containing a newline. Older releases are
 * untested rather than refused.
 */
export const DOCTOR_MIN_GIT_VERSION: readonly [number, number] = [2, 36];

/** How long `git ls-remote` gets to answer before the remote counts as unreachable. */
export const DOCTOR_REMOTE_TIMEOUT_MS = 15_000;

/** Local git commands (`--version`, `lfs version`, the LFS attribute grep). */
const DOCTOR_LOCAL_GIT_TIMEOUT_MS = 10_000;

/** Free space below which a repository's directory fails the disk check. */
export const DOCTOR_DISK_FAIL_BYTES = 100 * 1024 * 1024;
/** Free space below which a repository's directory gets a warning. */
export const DOCTOR_DISK_WARN_BYTES = 1024 * 1024 * 1024;

const REMOTE_CHECK_CONCURRENCY = 4;
const LFS_FILTER_ATTRIBUTE = "filter=lfs";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  /** Stable identifier: node, git, git-lfs, config, remote, worktree-dir, bare-repo-dir, disk-space, lock-dir, state-dir. */
  check: string;
  /** The repository the check is about; null for the machine-wide checks. */
  repository: string | null;
  status: DoctorStatus;
  message: string;
  /** What to do about a warning or a failure; null when there is nothing to do. */
  hint: string | null;
}

export interface GitRunResult {
  /** Exit code; null when git never ran (not installed) or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when git could not be started at all (ENOENT when it is not installed). */
  spawnError?: Error;
}

export interface DoctorDeps {
  nodeVersion: string;
  runGit(args: readonly string[], options: { cwd?: string; timeoutMs: number }): Promise<GitRunResult>;
  stat(target: string): Promise<{ isDirectory(): boolean }>;
  /** Resolves when `target` is writable; rejects otherwise. */
  accessWritable(target: string): Promise<void>;
  /** Free bytes available to this user on the filesystem holding `target`. */
  freeBytes(target: string): Promise<number>;
  findConfig(): Promise<string | null>;
  loadRepositories(configPath: string, filter?: string): Promise<RepositoryConfig[]>;
}

export interface DoctorOptions {
  config?: string;
  filter?: string;
}

export interface DoctorOutputOptions {
  json?: boolean;
  quiet?: boolean;
}

/**
 * Runs git without a controlling terminal. The sync's own clients go through
 * simple-git, which cannot start a child in its own session; here `detached`
 * does exactly that, so ssh cannot open /dev/tty for a key passphrase or a
 * host-key confirmation and fails at once instead of waiting on a prompt
 * nobody is watching (GIT_TERMINAL_PROMPT=0 only covers git's own prompts).
 * The environment is the same sanitized one every sync client uses, with
 * prompts forced off even when the user exported GIT_TERMINAL_PROMPT.
 */
export function runGitNonInteractive(
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const env = { ...sanitizeGitEnv(process.env), ...GIT_LOCALE_ENV, GIT_TERMINAL_PROMPT: "0" };
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: GitRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn("git", [...args], {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      // The whole process group: git's ssh or remote-https helper would
      // otherwise outlive it and keep the pipes open.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => finish({ code: null, stdout, stderr, timedOut, spawnError: error }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut }));
  });
}

export function createDefaultDoctorDeps(): DoctorDeps {
  return {
    nodeVersion: process.versions.node,
    runGit: runGitNonInteractive,
    stat: (target) => fs.stat(target),
    accessWritable: (target) => fs.access(target, fsConstants.W_OK),
    freeBytes: async (target) => {
      const stats = await fs.statfs(target);
      return stats.bavail * stats.bsize;
    },
    findConfig: () => findConfigInCwd(),
    loadRepositories: async (configPath, filter) =>
      (await new ConfigLoaderService().buildRepositories(configPath, { filter })).repositories,
  };
}

function check(
  id: string,
  repository: string | null,
  status: DoctorStatus,
  message: string,
  hint: string | null = null,
): DoctorCheck {
  return {
    check: id,
    repository,
    status,
    message: redactSecretsInText(message),
    hint: hint === null ? null : redactSecretsInText(hint),
  };
}

/** git's last meaningful stderr line: its `fatal:` line when there is one. */
function gitFailureLine(result: GitRunResult): string {
  const lines = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.find((line) => line.startsWith("fatal:")) ?? lines.at(-1) ?? `git exited with code ${result.code}`;
}

export function checkNode(nodeVersion: string): DoctorCheck {
  const engines = `>=${DOCTOR_MIN_NODE_MAJOR}.0.0`;
  const major = Number.parseInt(nodeVersion.split(".")[0], 10);
  if (Number.isNaN(major)) {
    return check("node", null, "warn", `Could not read the Node.js version '${nodeVersion}'`, null);
  }
  if (major < DOCTOR_MIN_NODE_MAJOR) {
    return check(
      "node",
      null,
      "warn",
      `Node.js ${nodeVersion} is older than package.json engines (${engines}); it runs, but untested`,
      `Upgrade to Node.js ${DOCTOR_MIN_NODE_MAJOR} or newer, or use sync-worktrees@5 on Node 22.`,
    );
  }
  return check("node", null, "pass", `Node.js ${nodeVersion} (engines: ${engines})`);
}

function parseGitVersion(output: string): [number, number, number] | null {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export async function checkGit(deps: Pick<DoctorDeps, "runGit">): Promise<DoctorCheck> {
  const result = await deps.runGit(["--version"], { timeoutMs: DOCTOR_LOCAL_GIT_TIMEOUT_MS });
  if (result.spawnError || result.code !== 0) {
    const reason = result.spawnError ? getErrorMessage(result.spawnError) : gitFailureLine(result);
    return check("git", null, "fail", `git could not be run: ${reason}`, "Install git and make sure it is on PATH.");
  }
  const version = parseGitVersion(result.stdout);
  const [minMajor, minMinor] = DOCTOR_MIN_GIT_VERSION;
  const minimum = `${minMajor}.${minMinor}`;
  if (!version) {
    return check("git", null, "warn", `Could not read the git version from '${result.stdout.trim()}'`, null);
  }
  const display = version.join(".");
  if (version[0] < minMajor || (version[0] === minMajor && version[1] < minMinor)) {
    return check(
      "git",
      null,
      "warn",
      `git ${display} is older than ${minimum}: worktree listings fall back to a format that cannot represent a path containing a newline, and older releases are untested`,
      `Upgrade git to ${minimum} or newer.`,
    );
  }
  return check("git", null, "pass", `git ${display} (${minimum} or newer recommended)`);
}

/** The repository's local git directory, when a sync has already created it. */
function localGitDir(repo: RepositoryConfig): string | undefined {
  return resolveMode(repo) === REPOSITORY_MODES.CLONE ? repo.worktreeDir : repo.bareRepoDir;
}

/**
 * Whether HEAD of an already-synced repository declares LFS files. Unknown
 * (false) for a repository that has not been synced yet: its tree is not
 * here to look at, and fetching it just to find out is not a doctor's job.
 */
async function repositoryUsesLfs(repo: RepositoryConfig, deps: DoctorDeps): Promise<boolean> {
  if (repo.skipLfs === true) return false;
  const gitDir = localGitDir(repo);
  if (!gitDir) return false;
  try {
    if (!(await deps.stat(gitDir)).isDirectory()) return false;
  } catch {
    return false;
  }
  const result = await deps.runGit(
    ["grep", "--name-only", "-I", "--fixed-strings", "-e", LFS_FILTER_ATTRIBUTE, "HEAD", "--", "*.gitattributes"],
    { cwd: gitDir, timeoutMs: DOCTOR_LOCAL_GIT_TIMEOUT_MS },
  );
  return result.code === 0 && result.stdout.trim().length > 0;
}

export async function checkGitLfs(repositories: readonly RepositoryConfig[], deps: DoctorDeps): Promise<DoctorCheck> {
  const result = await deps.runGit(["lfs", "version"], { timeoutMs: DOCTOR_LOCAL_GIT_TIMEOUT_MS });
  if (!result.spawnError && result.code === 0) {
    return check("git-lfs", null, "pass", result.stdout.trim().split("\n")[0] || "git-lfs is installed");
  }

  const usesLfs: string[] = [];
  for (const repo of repositories) {
    if (await repositoryUsesLfs(repo, deps)) usesLfs.push(repo.name);
  }
  if (usesLfs.length === 0) {
    return check(
      "git-lfs",
      null,
      "pass",
      "git-lfs is not installed; no synced repository declares LFS files (skipLfs repositories and ones not cloned yet are not checked)",
    );
  }
  return check(
    "git-lfs",
    null,
    "warn",
    `git-lfs is not installed, but ${usesLfs.join(", ")} ${usesLfs.length === 1 ? "uses" : "use"} LFS: new worktrees get pointer files instead of content`,
    "Install git-lfs (then `git lfs install`), or set 'skipLfs: true' on those repositories.",
  );
}

export async function checkRemote(repo: RepositoryConfig, deps: Pick<DoctorDeps, "runGit">): Promise<DoctorCheck> {
  const url = redactRepoUrl(repo.repoUrl);
  const result = await deps.runGit(["ls-remote", "--heads", "--", repo.repoUrl], {
    timeoutMs: DOCTOR_REMOTE_TIMEOUT_MS,
  });
  if (result.timedOut) {
    return check(
      "remote",
      repo.name,
      "fail",
      `${url} did not answer within ${DOCTOR_REMOTE_TIMEOUT_MS / 1000}s`,
      "Check the network, a proxy, or an ssh prompt that cannot be answered (a passphrase-protected key without ssh-agent, an unknown host key).",
    );
  }
  if (result.spawnError || result.code !== 0) {
    const reason = result.spawnError ? getErrorMessage(result.spawnError) : gitFailureLine(result);
    const hint =
      getGitAuthHint(result.stderr) ??
      "Check that repoUrl is spelled right and that this machine can reach it (`git ls-remote <repoUrl>`).";
    return check("remote", repo.name, "fail", `${url} is not reachable: ${reason}`, hint);
  }
  const branches = result.stdout.split("\n").filter((line) => line.trim().length > 0).length;
  return check(
    "remote",
    repo.name,
    "pass",
    `${url} is reachable (${branches} ${branches === 1 ? "branch" : "branches"})`,
  );
}

/** The directory itself when it exists, else its nearest existing ancestor. */
async function nearestExisting(
  target: string,
  deps: Pick<DoctorDeps, "stat">,
): Promise<{ dir: string; exists: boolean; isDirectory: boolean }> {
  let candidate = path.resolve(target);
  for (;;) {
    try {
      const stats = await deps.stat(candidate);
      return { dir: candidate, exists: candidate === path.resolve(target), isDirectory: stats.isDirectory() };
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return { dir: candidate, exists: false, isDirectory: false };
      candidate = parent;
    }
  }
}

export async function checkWritableDir(
  id: string,
  repository: string | null,
  label: string,
  target: string,
  deps: Pick<DoctorDeps, "stat" | "accessWritable">,
): Promise<DoctorCheck> {
  const found = await nearestExisting(target, deps);
  if (!found.isDirectory) {
    return check(
      id,
      repository,
      "fail",
      `${label} ${target}: ${found.dir} is not a directory`,
      `Move the file at ${found.dir} out of the way, or point ${label} somewhere else.`,
    );
  }
  try {
    await deps.accessWritable(found.dir);
  } catch {
    return check(
      id,
      repository,
      "fail",
      found.exists
        ? `${label} ${target} is not writable`
        : `${label} ${target} cannot be created: ${found.dir} is not writable`,
      `Give the user running sync-worktrees write access to ${found.dir}, or point ${label} somewhere else.`,
    );
  }
  return check(
    id,
    repository,
    "pass",
    found.exists ? `${label} ${target} is writable` : `${label} ${target} will be created under ${found.dir}`,
  );
}

export async function checkDiskSpace(
  repo: RepositoryConfig,
  deps: Pick<DoctorDeps, "stat" | "freeBytes">,
): Promise<DoctorCheck[]> {
  const targets = [repo.worktreeDir];
  if (resolveMode(repo) !== REPOSITORY_MODES.CLONE && repo.bareRepoDir) targets.push(repo.bareRepoDir);

  const checks: DoctorCheck[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const { dir } = await nearestExisting(target, deps);
    if (seen.has(dir)) continue;
    seen.add(dir);
    let free: number;
    try {
      free = await deps.freeBytes(dir);
    } catch (error) {
      checks.push(
        check("disk-space", repo.name, "warn", `Could not read free space on ${dir}: ${getErrorMessage(error)}`, null),
      );
      continue;
    }
    const status: DoctorStatus =
      free < DOCTOR_DISK_FAIL_BYTES ? "fail" : free < DOCTOR_DISK_WARN_BYTES ? "warn" : "pass";
    checks.push(
      check(
        "disk-space",
        repo.name,
        status,
        `${formatBytes(free)} free on ${dir}`,
        status === "pass" ? null : "Free up space there; clones and new worktrees need room to check out.",
      ),
    );
  }
  return checks;
}

async function checkRepository(repo: RepositoryConfig, deps: DoctorDeps): Promise<DoctorCheck[]> {
  const isClone = resolveMode(repo) === REPOSITORY_MODES.CLONE;
  const checks: DoctorCheck[] = [await checkRemote(repo, deps)];
  checks.push(await checkWritableDir("worktree-dir", repo.name, "worktreeDir", repo.worktreeDir, deps));
  if (!isClone && repo.bareRepoDir) {
    checks.push(await checkWritableDir("bare-repo-dir", repo.name, "bareRepoDir", repo.bareRepoDir, deps));
  }
  checks.push(...(await checkDiskSpace(repo, deps)));
  checks.push(
    await checkWritableDir("lock-dir", repo.name, "lock directory", getWorktreeDirLockTarget(repo).dir, deps),
  );
  checks.push(
    await checkWritableDir("state-dir", repo.name, "state directory", path.dirname(getRemovalAuditLogPath(repo)), deps),
  );
  return checks;
}

/** Every check, machine-wide ones first, then each repository's in config order. */
export async function runDoctorChecks(options: DoctorOptions, deps: DoctorDeps): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [checkNode(deps.nodeVersion)];
  const git = await checkGit(deps);
  checks.push(git);

  let repositories: RepositoryConfig[] = [];
  const configPath = options.config ? path.resolve(options.config) : await deps.findConfig();
  let configCheck: DoctorCheck;
  if (!configPath) {
    configCheck = check(
      "config",
      null,
      "fail",
      "No config file found in the current directory",
      "Pass --config <path>, or run 'sync-worktrees init' to create one.",
    );
  } else {
    try {
      repositories = await deps.loadRepositories(configPath, options.filter);
      if (options.filter && repositories.length === 0) {
        configCheck = check(
          "config",
          null,
          "fail",
          `${configPath} loaded, but no repository matches filter '${options.filter}'`,
          "Run 'sync-worktrees list' to see the configured names.",
        );
      } else {
        const count = `${repositories.length} ${repositories.length === 1 ? "repository" : "repositories"}`;
        configCheck = check("config", null, "pass", `${configPath} is valid (${count})`);
      }
    } catch (error) {
      configCheck =
        error instanceof ConfigFileNotFoundError
          ? check(
              "config",
              null,
              "fail",
              `Config file not found: ${configPath}`,
              `Run 'sync-worktrees init --config ${configPath}' to create one.`,
            )
          : check(
              "config",
              null,
              "fail",
              `${configPath} does not load: ${getErrorMessage(error).replace(/^Failed to load config file: /, "")}`,
              "Fix the reported setting; docs/configuration.md lists every key.",
            );
    }
  }

  // Everything below runs git; without it each check would only repeat the
  // git failure above.
  if (git.status === "fail") {
    checks.push(configCheck);
    return checks;
  }

  checks.push(await checkGitLfs(repositories, deps));
  checks.push(configCheck);

  const limit = pLimit(REMOTE_CHECK_CONCURRENCY);
  const perRepository = await Promise.all(repositories.map((repo) => limit(() => checkRepository(repo, deps))));
  for (const repoChecks of perRepository) checks.push(...repoChecks);
  return checks;
}

const STATUS_LABELS: Record<DoctorStatus, { icon: string; word: string; color: string }> = {
  pass: { icon: "✅", word: "PASS", color: "\u001b[32m" },
  warn: { icon: "⚠️ ", word: "WARN", color: "\u001b[33m" },
  fail: { icon: "❌", word: "FAIL", color: "\u001b[31m" },
};

/**
 * The human report: one line per check, a hint under each warning and
 * failure, and a closing count. `quiet` keeps only warnings, failures and the
 * count, like `--run-once --quiet`; `color` follows NO_COLOR / FORCE_COLOR.
 */
export function formatDoctorReport(
  checks: readonly DoctorCheck[],
  options: { quiet?: boolean; color?: boolean } = {},
): string[] {
  const lines: string[] = [];
  for (const item of checks) {
    if (options.quiet && item.status === "pass") continue;
    const label = STATUS_LABELS[item.status];
    const word = options.color ? `${label.color}${label.word}\u001b[0m` : label.word;
    const subject = item.repository ? `${item.repository} › ${item.check}` : item.check;
    lines.push(`${label.icon} ${word}  ${subject}: ${item.message}`);
    if (item.hint && item.status !== "pass") lines.push(`   💡 ${item.hint}`);
  }
  const count = (status: DoctorStatus): number => checks.filter((item) => item.status === status).length;
  const warnings = count("warn");
  const failures = count("fail");
  if (lines.length > 0) lines.push("");
  lines.push(`🩺 ${count("pass")} passed, ${warnings} ${warnings === 1 ? "warning" : "warnings"}, ${failures} failed`);
  return lines;
}

/** 0 when nothing failed; warnings do not fail the run. */
export function doctorExitCode(checks: readonly DoctorCheck[]): number {
  return checks.some((item) => item.status === "fail") ? 1 : 0;
}

/** `sync-worktrees doctor`: prints the report (or JSON) and returns the exit code. */
export async function runDoctor(
  options: DoctorOptions & DoctorOutputOptions,
  deps: DoctorDeps = createDefaultDoctorDeps(),
  write: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  const checks = await runDoctorChecks({ config: options.config, filter: options.filter }, deps);
  if (options.json) {
    write(JSON.stringify(checks, null, 2));
  } else {
    for (const line of formatDoctorReport(checks, { quiet: options.quiet, color: colorsEnabled() })) write(line);
  }
  return doctorExitCode(checks);
}
