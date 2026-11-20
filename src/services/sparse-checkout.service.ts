import * as path from "path";

import { createGitClient } from "../utils/git-client";

import { Logger } from "./logger.service";

import type { SparseCheckoutConfig, SparseCheckoutMode } from "../types";
import type { SimpleGit } from "simple-git";

export type GitFactory = (worktreePath: string) => SimpleGit;

const compareUtf8 = (a: string, b: string): number => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

export const modeFor = (cfg: SparseCheckoutConfig): SparseCheckoutMode => {
  if (cfg.mode === "no-cone") return "no-cone";
  if ((cfg.exclude?.length ?? 0) > 0 || cfg.include.some((p) => p.trim().startsWith("!"))) return "no-cone";
  return cfg.mode ?? "cone";
};

const canonicalizeConePatterns = (patterns: string[]): string[] => {
  const dirs = [...new Set(patterns.map((p) => normalizeConeDirectory(p)))].sort(compareUtf8);
  const included = new Set(dirs);

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
  if (withoutTrailingSlash.length === 0) return pattern;
  return path.posix.normalize(withoutTrailingSlash);
};

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
  if (applied === ".") {
    return "selects only the files at the repository root: name the directories to include, or drop sparseCheckout to check out everything.";
  }
  if (applied === ".." || applied.startsWith("../")) {
    return "climbs above the repository root with '..': cone mode takes directories inside the repository.";
  }
  return null;
};

export function findConeRuleViolations(cfg: SparseCheckoutConfig): string[] {
  if (modeFor(cfg) !== "cone") return [];

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

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

const unquoteC = (line: string): string => {
  if (line.length < 2 || !line.startsWith('"') || !line.endsWith('"')) return line;
  const body = line.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[i + 1] ?? "";
    const octal = /^[0-3][0-7]{2}/.exec(body.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next]);
      i += 1;
    } else {
      return line;
    }
  }
  return Buffer.from(bytes).toString("utf8");
};

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

  async applyToWorktree(worktreePath: string, cfg: SparseCheckoutConfig, gitOverride?: SimpleGit): Promise<void> {
    const mode = this.resolveMode(cfg);
    const patterns = this.buildPatternsForMode(cfg, mode);

    if (patterns.length === 0) {
      throw new Error("sparseCheckout produced no patterns; refusing to apply empty config");
    }

    const git = gitOverride ?? this.gitFactory(worktreePath);
    await git.raw(["sparse-checkout", "init", mode === "cone" ? "--cone" : "--no-cone"]);
    await git.raw(["sparse-checkout", "set", mode === "cone" ? "--cone" : "--no-cone", "--", ...patterns]);
  }

  async readCurrent(worktreePath: string, mode?: SparseCheckoutMode | null): Promise<string[] | null> {
    const git = this.gitFactory(worktreePath);
    try {
      const out = await git.raw(["-c", "core.quotePath=false", "sparse-checkout", "list"]);
      const lines = out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"))
        .map((l) => (mode === "no-cone" ? l : unquoteC(l)));
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
    const current = await this.readCurrent(worktreePath, currentMode);
    if (current === null) return true;
    return !this.patternsEqual(current, this.buildPatternsForMode(cfg, desiredMode));
  }

  isNarrowing(
    currentPatterns: string[] | null,
    nextPatterns: string[],
    currentMode?: SparseCheckoutMode | null,
    nextMode?: SparseCheckoutMode,
  ): boolean {
    if (!currentPatterns || currentPatterns.length === 0) return false;
    if (currentMode === "cone" && nextMode === "no-cone") return true;

    const isNeg = (p: string): boolean => p.startsWith("!");
    const trim = (xs: string[]): string[] => xs.map((p) => p.trim()).filter((p) => p.length > 0);

    const cur = trim(currentPatterns);
    const next = trim(nextPatterns);

    const positiveCurrent = new Set(cur.filter((p) => !isNeg(p)));
    const negativeCurrent = new Set(cur.filter(isNeg));
    const positiveNext = new Set(next.filter((p) => !isNeg(p)));
    const negativeNext = new Set(next.filter(isNeg));

    const cone =
      currentMode !== "no-cone" &&
      nextMode !== "no-cone" &&
      [...cur, ...next].every((p) => !isNeg(p) && !p.startsWith("/") && !/[*?[\]]/.test(p));
    const covered = (p: string): boolean => {
      if (positiveNext.has(p)) return true;
      if (!cone) return false;
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) {
        if (positiveNext.has(parts.slice(0, i).join("/"))) return true;
      }
      return false;
    };

    for (const p of positiveCurrent) {
      if (!covered(p)) return true;
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
