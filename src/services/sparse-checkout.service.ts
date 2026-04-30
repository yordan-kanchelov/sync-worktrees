import * as path from "path";

import simpleGit from "simple-git";

import { Logger } from "./logger.service";

import type { SparseCheckoutConfig, SparseCheckoutMode } from "../types";
import type { SimpleGit } from "simple-git";

export type GitFactory = (worktreePath: string) => SimpleGit;

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
    this.gitFactory = gitFactory ?? ((p: string): SimpleGit => simpleGit(p));
  }

  updateLogger(logger: Logger): void {
    this.logger = logger;
  }

  resolveMode(cfg: SparseCheckoutConfig): SparseCheckoutMode {
    const hasExclude = !!cfg.exclude && cfg.exclude.length > 0;
    const hasNegation = cfg.include.some((p) => p.trim().startsWith("!"));

    if (cfg.mode === "no-cone") return "no-cone";
    if (hasExclude || hasNegation) {
      if (cfg.mode === "cone" && !this.warnedConfigs.has(cfg)) {
        this.logger.warn(
          "sparseCheckout: mode 'cone' is incompatible with excludes or negation patterns; auto-promoting to 'no-cone'",
        );
        this.warnedConfigs.add(cfg);
      }
      return "no-cone";
    }
    return cfg.mode ?? "cone";
  }

  buildPatterns(cfg: SparseCheckoutConfig): string[] {
    return this.buildPatternsForMode(cfg, this.resolveMode(cfg));
  }

  private buildPatternsForMode(cfg: SparseCheckoutConfig, mode: SparseCheckoutMode): string[] {
    const includes = cfg.include.map((p) => p.trim()).filter((p) => p.length > 0);

    if (mode === "cone") {
      return includes;
    }

    const excludes = (cfg.exclude ?? [])
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => (p.startsWith("!") ? p : `!${p}`));

    return [...includes, ...excludes];
  }

  async applyToWorktree(worktreePath: string, cfg: SparseCheckoutConfig): Promise<void> {
    const mode = this.resolveMode(cfg);
    const patterns = this.buildPatternsForMode(cfg, mode);

    if (patterns.length === 0) {
      throw new Error("sparseCheckout produced no patterns; refusing to apply empty config");
    }

    const git = this.gitFactory(worktreePath);
    await git.raw(["sparse-checkout", "init", mode === "cone" ? "--cone" : "--no-cone"]);
    await git.raw(["sparse-checkout", "set", mode === "cone" ? "--cone" : "--no-cone", ...patterns]);
  }

  async readCurrent(worktreePath: string): Promise<string[] | null> {
    const git = this.gitFactory(worktreePath);
    try {
      const out = await git.raw(["sparse-checkout", "list"]);
      const lines = out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
      return lines.length === 0 ? null : lines;
    } catch {
      return null;
    }
  }

  async needsUpdate(worktreePath: string, cfg: SparseCheckoutConfig): Promise<boolean> {
    const current = await this.readCurrent(worktreePath);
    const desired = this.buildPatterns(cfg);
    if (current === null) return true;
    return !this.patternsEqual(current, desired);
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

    const patterns = cfg.include
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => (p.endsWith("/") ? p.slice(0, -1) : p));

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
