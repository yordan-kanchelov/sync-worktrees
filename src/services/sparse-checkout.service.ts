import * as path from "path";

import { createGitClient } from "../utils/git-client";

import { Logger } from "./logger.service";

import type { SparseCheckoutConfig, SparseCheckoutMode } from "../types";
import type { SimpleGit } from "simple-git";

export type GitFactory = (worktreePath: string) => SimpleGit;

// git sorts its pattern list by UTF-8 bytes; JavaScript's default sort compares
// UTF-16 code units, which orders an astral name against a U+E000-U+FFFF one
// the other way round.
const compareUtf8 = (a: string, b: string): number => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

// Which mode a config really runs in, with none of the warning `resolveMode`
// attaches to the answer. Both callers must agree: the validator refuses cone
// patterns git would refuse, so it has to be looking at the same mode the
// apply step will pick.
const modeFor = (cfg: SparseCheckoutConfig): SparseCheckoutMode => {
  if (cfg.mode === "no-cone") return "no-cone";
  if ((cfg.exclude?.length ?? 0) > 0 || cfg.include.some((p) => p.trim().startsWith("!"))) return "no-cone";
  return cfg.mode ?? "cone";
};

/**
 * Reshape cone directories the way `sparse-checkout set --cone` normalizes
 * its arguments - which is the form `sparse-checkout list` then prints back:
 * each path normalized, no trailing slash, deduplicated, sorted by UTF-8
 * bytes, and without any entry an included parent already covers. Applying
 * the canonical form changes nothing on disk; it only lets `patternsEqual`
 * recognize an unchanged config instead of re-applying the same patterns
 * (and checking HEAD back out) on every sync.
 *
 * No-cone patterns are left alone: there a trailing slash restricts the
 * match to directories, order decides which negation wins, and
 * `sparse-checkout list` echoes the file verbatim.
 */
const canonicalizeConePatterns = (patterns: string[]): string[] => {
  const dirs = [...new Set(patterns.map((p) => normalizeConeDirectory(p)))].sort(compareUtf8);
  const included = new Set(dirs);

  // Normalizing first is what makes this parent check safe: `apps/../docs`
  // only looks like it lives under `apps`, and dropping it would delete
  // `docs/` from every worktree git had materialized it in.
  return dirs.filter((p) => {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (included.has(parts.slice(0, i).join("/"))) return false;
    }
    return true;
  });
};

const normalizeConeDirectory = (pattern: string): string => {
  const withoutTrailingSlash = pattern.replace(/\/+$/, "");
  // Nothing but slashes: no directory left to normalize, so keep the entry as
  // written and let git report it the way it does today.
  if (withoutTrailingSlash.length === 0) return pattern;
  return path.posix.normalize(withoutTrailingSlash);
};

// The four ways `sparse-checkout set --cone` refuses an argument, checked
// against real git 2.43.0 and 2.55.0, which answer identically: a leading
// slash, a leading '!', any of `*?[]` anywhere, and a path that normalizes
// above the repository root. Everything else git takes, however odd it looks -
// a backslash (named in git's own message but absent from its check), a space,
// a brace, '#', '~', a Windows-style path, a name that does not exist yet, and
// `.`, which quietly selects nothing. Two of git's refusals are deliberately
// not mirrored: `--skip-checks` is never passed here, and "is not a directory"
// depends on what the index holds at apply time, which a config load cannot
// know. `exclude` needs no check of its own - a non-empty `exclude` is exactly
// what demotes a config out of cone mode.
const coneRuleBroken = (applied: string): string | null => {
  if (applied.startsWith("/")) {
    return "starts with '/': cone mode takes directories relative to the repository root. Drop the leading slash, or set sparseCheckout.mode to 'no-cone' for gitignore-style patterns.";
  }
  if (applied.startsWith("!")) {
    return "starts with '!': cone mode takes directory names, not negations. Move it to sparseCheckout.exclude, or set sparseCheckout.mode to 'no-cone'.";
  }
  if (/[*?[\]]/.test(applied)) {
    return "contains one of '*', '?', '[' or ']': cone mode takes directory names, not globs. Name the directory itself, or set sparseCheckout.mode to 'no-cone' for gitignore-style patterns.";
  }
  if (applied === ".." || applied.startsWith("../")) {
    return "climbs above the repository root with '..': cone mode takes directories inside the repository.";
  }
  return null;
};

/**
 * Cone-mode `include` entries `git sparse-checkout set --cone` would reject,
 * as one sentence each naming the entry and the rule. Empty in no-cone mode,
 * where patterns are legal. Judges the canonical directory list the apply step
 * actually passes to git, so an entry a normalization or an included parent
 * removes before git sees it is not reported.
 */
export function findConeRuleViolations(cfg: SparseCheckoutConfig): string[] {
  if (modeFor(cfg) !== "cone") return [];

  // Same input `buildPatternsForMode` gives the canonicalizer, so the list
  // below is the argv git would see, entry for entry.
  const includes = cfg.include.map((p) => p.trim()).filter((p) => p.length > 0);

  const asWritten = new Map<string, string>();
  for (const entry of cfg.include) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const applied = normalizeConeDirectory(trimmed);
    if (!asWritten.has(applied)) asWritten.set(applied, entry);
  }

  const violations: string[] = [];
  for (const applied of canonicalizeConePatterns(includes)) {
    const broken = coneRuleBroken(applied);
    if (!broken) continue;
    const written = asWritten.get(applied) ?? applied;
    const shown = written.trim() === applied ? `'${written}'` : `'${written}' (applied as '${applied}')`;
    violations.push(`cone-mode 'include' entry ${shown} ${broken}`);
  }
  return violations;
}

interface SparseMatcher {
  mode: SparseCheckoutMode;
  patterns: string[];
  ancestorDirs: Set<string>;
}

export class SparseCheckoutService {
  private logger: Logger;
  private gitFactory: GitFactory;
  private warnedConfigs = new WeakSet<SparseCheckoutConfig>();
  private matcherCache = new WeakMap<SparseCheckoutConfig, SparseMatcher>();

  constructor(logger?: Logger, gitFactory?: GitFactory) {
    this.logger = logger ?? Logger.createDefault();
    this.gitFactory = gitFactory ?? ((p: string): SimpleGit => createGitClient(p));
  }

  updateLogger(logger: Logger): void {
    this.logger = logger;
  }

  resolveMode(cfg: SparseCheckoutConfig): SparseCheckoutMode {
    const mode = modeFor(cfg);
    // Only excludes or a negated include can demote an explicit 'cone'.
    if (mode === "no-cone" && cfg.mode === "cone" && !this.warnedConfigs.has(cfg)) {
      this.logger.warn(
        "sparseCheckout: mode 'cone' is incompatible with excludes or negation patterns; auto-promoting to 'no-cone'",
      );
      this.warnedConfigs.add(cfg);
    }
    return mode;
  }

  buildPatterns(cfg: SparseCheckoutConfig): string[] {
    return this.buildPatternsForMode(cfg, this.resolveMode(cfg));
  }

  private buildPatternsForMode(cfg: SparseCheckoutConfig, mode: SparseCheckoutMode): string[] {
    const includes = cfg.include.map((p) => p.trim()).filter((p) => p.length > 0);

    if (mode === "cone") {
      return canonicalizeConePatterns(includes);
    }

    const excludes = (cfg.exclude ?? [])
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => (p.startsWith("!") ? p : `!${p}`));

    return [...includes, ...excludes];
  }

  /**
   * `init` and `set` are the only commands here that touch the working tree:
   * `set` materializes everything the new pattern list brings into the cone,
   * which runs the smudge filter over those paths. A caller whose checkout
   * only succeeded with LFS smudging disabled must therefore run this step the
   * same way, or it dies on the objects that checkout just skipped and leaves
   * a half-narrowed tree behind — so it may pass the client to use. Everything
   * else in this service only reads config and patterns, and keeps the
   * service's own factory.
   */
  async applyToWorktree(worktreePath: string, cfg: SparseCheckoutConfig, gitOverride?: SimpleGit): Promise<void> {
    const mode = this.resolveMode(cfg);
    const patterns = this.buildPatternsForMode(cfg, mode);

    if (patterns.length === 0) {
      throw new Error("sparseCheckout produced no patterns; refusing to apply empty config");
    }

    const git = gitOverride ?? this.gitFactory(worktreePath);
    await git.raw(["sparse-checkout", "init", mode === "cone" ? "--cone" : "--no-cone"]);
    // `--` or a directory whose name begins with a dash is read as an option
    // instead of a path, in both modes. git 2.43 passed
    // PARSE_OPT_KEEP_UNKNOWN_OPT here and let `-apps` through; 2.55 dropped it
    // and dies with "unknown switch `a'" — a per-branch, per-tick failure on
    // the git CI runs, naming neither the entry nor the reason. Both versions
    // also read a directory named `--skip-checks` as the flag, which turns off
    // the very checks validated at load and silently leaves the pattern list
    // empty, and one named `--cone`/`--no-cone` as the mode. After `--` every
    // argument is the path the config asked for, which is what the load-time
    // cone rules assume they are judging.
    await git.raw(["sparse-checkout", "set", mode === "cone" ? "--cone" : "--no-cone", "--", ...patterns]);
  }

  async readCurrent(worktreePath: string): Promise<string[] | null> {
    const git = this.gitFactory(worktreePath);
    try {
      // Cone mode C-quotes non-ASCII directories (`"caf\303\251"`) unless
      // quoting is off, and a quoted line never compares equal to the pattern
      // the config asked for. Names holding a backslash or a quote stay
      // escaped either way.
      const out = await git.raw(["-c", "core.quotePath=false", "sparse-checkout", "list"]);
      const lines = out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
      return lines.length === 0 ? null : lines;
    } catch {
      return null;
    }
  }

  async readCurrentMode(worktreePath: string): Promise<SparseCheckoutMode | null> {
    const git = this.gitFactory(worktreePath);
    try {
      const out = await git.raw(["config", "--bool", "--get", "core.sparseCheckoutCone"]);
      const value = out.trim().toLowerCase();
      if (value === "true") return "cone";
      if (value === "false") return "no-cone";
      return null;
    } catch {
      return null;
    }
  }

  async needsUpdate(worktreePath: string, cfg: SparseCheckoutConfig): Promise<boolean> {
    const desiredMode = this.resolveMode(cfg);
    const currentMode = await this.readCurrentMode(worktreePath);
    if (currentMode !== desiredMode) return true;
    const current = await this.readCurrent(worktreePath);
    if (current === null) return true;
    return !this.patternsEqual(current, this.buildPatternsForMode(cfg, desiredMode));
  }

  isNarrowing(currentPatterns: string[] | null, nextPatterns: string[]): boolean {
    if (!currentPatterns || currentPatterns.length === 0) return false;

    const isNeg = (p: string): boolean => p.startsWith("!");
    const trim = (xs: string[]): string[] => xs.map((p) => p.trim()).filter((p) => p.length > 0);

    const cur = trim(currentPatterns);
    const next = trim(nextPatterns);

    const positiveCurrent = new Set(cur.filter((p) => !isNeg(p)));
    const negativeCurrent = new Set(cur.filter(isNeg));
    const positiveNext = new Set(next.filter((p) => !isNeg(p)));
    const negativeNext = new Set(next.filter(isNeg));

    for (const p of positiveCurrent) {
      if (!positiveNext.has(p)) return true;
    }
    for (const p of negativeNext) {
      if (!negativeCurrent.has(p)) return true;
    }
    return false;
  }

  patternsEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const at = a.map((x) => x.trim());
    const bt = b.map((x) => x.trim());
    return at.every((v, i) => v === bt[i]);
  }

  /**
   * Decide whether a list of changed file paths intersects the sparse-checkout
   * set defined by `cfg`. Used to skip fast-forward updates when upstream
   * commits only touch files outside the materialized worktree.
   *
   * Cone mode materializes:
   *   - all files at the repository root,
   *   - all files directly inside every ancestor of an included directory
   *     (e.g. include `tools/build` keeps `tools/foo.txt` checked out too),
   *   - everything inside an included directory.
   * We mirror those rules here. Missing the ancestor-files case would let
   * stale files linger when only those parent files change upstream.
   *
   * No-cone mode: gitignore-style matching with negation is non-trivial and
   * not implemented here yet. We return `true` so the caller falls back to
   * the safe behavior of always running the update.
   *
   * The matcher derived from `cfg` is cached on the cfg object identity
   * (WeakMap), so callers should reuse the same `cfg` reference across
   * invocations to benefit from the cache.
   */
  pathsTouchSparse(changedPaths: string[], cfg: SparseCheckoutConfig): boolean {
    if (changedPaths.length === 0) return false;

    const matcher = this.getMatcher(cfg);
    if (matcher.mode === "no-cone") return true;
    if (matcher.patterns.length === 0) return true;

    return changedPaths.some((p) => {
      if (!p.includes("/")) return true;
      for (const pat of matcher.patterns) {
        if (p === pat || p.startsWith(pat + "/")) return true;
      }
      return matcher.ancestorDirs.has(path.posix.dirname(p));
    });
  }

  private getMatcher(cfg: SparseCheckoutConfig): SparseMatcher {
    const cached = this.matcherCache.get(cfg);
    if (cached) return cached;

    const mode = this.resolveMode(cfg);
    if (mode === "no-cone") {
      const matcher: SparseMatcher = { mode, patterns: [], ancestorDirs: new Set() };
      this.matcherCache.set(cfg, matcher);
      return matcher;
    }

    const patterns = this.buildPatternsForMode(cfg, mode);

    const ancestorDirs = new Set<string>();
    for (const pat of patterns) {
      const parts = pat.split("/");
      for (let i = 1; i < parts.length; i++) {
        ancestorDirs.add(parts.slice(0, i).join("/"));
      }
    }

    const matcher: SparseMatcher = { mode, patterns, ancestorDirs };
    this.matcherCache.set(cfg, matcher);
    return matcher;
  }
}
