import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setEnvVar } from "../../__tests__/test-utils";
import { DEFAULT_CONFIG, ENV_CONSTANTS } from "../../constants";
import { getWorktreeDirLockTarget } from "../../utils/lock-path";
import { CLONE_MODE_CONFLICTING_FIELDS, ConfigLoaderService } from "../config-loader.service";

import type { RepositoryConfig } from "../../types";

/**
 * The shipped example config is the reference README.md sends people to for
 * "every knob", and it is meant to be copied and run. Nothing else in the
 * suite loads it, so validation rules added to ConfigLoaderService could —
 * and did — leave it failing to load: a per-repository `runOnce` became a
 * validation error while the example still carried one, so the file the README
 * points at threw on load.
 *
 * These tests are that guard. They load the real shipped file, not a fixture.
 */
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../..");
const EXAMPLE_CONFIG_PATH = path.join(REPO_ROOT, "sync-worktrees.config.example.js");

/**
 * Every repository the example documents, in file order. Pinned so that an
 * entry cannot be silently dropped (or a stray one added) while the file still
 * loads.
 */
const EXAMPLE_REPOSITORY_NAMES = [
  "my-main-project",
  "work-project",
  "documentation",
  "experimental-features",
  "active-development",
  "legacy-project",
  "filtered-branches",
  "large-media-project",
  "monorepo-game-client",
  "monorepo-autocue",
  "monorepo-with-excludes",
  "read-only-reference",
  "project-with-hooks",
  "game-platform",
  "base-slot",
  "communicator-base",
];

describe("sync-worktrees.config.example.js", () => {
  const originalLockDir = process.env[ENV_CONSTANTS.LOCK_DIR];
  let configLoader: ConfigLoaderService;

  beforeEach(() => {
    configLoader = new ConfigLoaderService();
    // getWorktreeDirLockTarget honours this override, and the lock-path
    // assertions below are about the default placement.
    setEnvVar(ENV_CONSTANTS.LOCK_DIR, undefined);
  });

  afterEach(() => {
    setEnvVar(ENV_CONSTANTS.LOCK_DIR, originalLockDir);
  });

  it("loads cleanly and resolves every documented repository", async () => {
    const { repositories, configFile } = await configLoader.buildRepositories(EXAMPLE_CONFIG_PATH);

    expect(repositories.map((repo) => repo.name)).toEqual(EXAMPLE_REPOSITORY_NAMES);
    expect(repositories).toHaveLength(EXAMPLE_REPOSITORY_NAMES.length);

    // `runOnce` is a whole-file setting: it belongs under `defaults`, and a
    // repository entry carrying one is a validation error. Asserted against the
    // raw entries as well as through the loader, so the example stays correct
    // even if that validation rule is ever relaxed.
    expect(configFile.defaults?.runOnce).toBe(false);
    for (const repo of configFile.repositories) {
      expect(Object.prototype.hasOwnProperty.call(repo, "runOnce")).toBe(false);
    }
  });

  it("sets no key that the loader drops on the floor", async () => {
    const { repositories, configFile } = await configLoader.buildRepositories(EXAMPLE_CONFIG_PATH);
    const resolvedByName = new Map<string, RepositoryConfig>(repositories.map((repo) => [repo.name, repo]));

    // Documenting a knob the code ignores is worse than leaving it out: the
    // file is meant to be copied, and a setting the loader never carries into
    // the resolved repository config never reaches a service. `fetchTimeoutMs`
    // and `cloneTimeoutMs` were exactly that — read by GitService and
    // CloneSyncService, documented on `Config`, and dropped on the floor by
    // resolveRepositoryConfig — so the example now sets them for real and this
    // guard covers them like every other key.
    for (const rawRepo of configFile.repositories) {
      const resolved = resolvedByName.get(rawRepo.name);
      expect(resolved).toBeDefined();
      for (const key of Object.keys(rawRepo)) {
        expect({ repository: rawRepo.name, key, carriedIntoResolvedConfig: key in resolved! }).toEqual({
          repository: rawRepo.name,
          key,
          carriedIntoResolvedConfig: true,
        });
      }
    }

    for (const key of Object.keys(configFile.defaults ?? {})) {
      expect({ key, carriedIntoResolvedConfig: repositories.some((repo) => key in repo) }).toEqual({
        key,
        carriedIntoResolvedConfig: true,
      });
    }
  });

  it("resolves the nested knobs the README promises", async () => {
    const { repositories } = await configLoader.buildRepositories(EXAMPLE_CONFIG_PATH);
    const byName = new Map<string, RepositoryConfig>(repositories.map((repo) => [repo.name, repo]));

    // The README sends people here for parallelism, jitter, sparse-update
    // behaviour, retry tuning and the trash block. The check above only reaches
    // top-level keys, because the blocks below are merged wholesale, so each
    // nested value is read back off the RESOLVED repository — the object the
    // services actually receive — rather than off the config file.
    const topLevelBlocksReachRepos = byName.get("my-main-project");
    expect(topLevelBlocksReachRepos?.parallelism?.maxBranchFetches).toBe(3);
    expect(topLevelBlocksReachRepos?.parallelism?.maxStatusChecks).toBe(20);
    expect(topLevelBlocksReachRepos?.retry?.jitterMs).toBe(500);

    expect(byName.get("monorepo-game-client")?.sparseCheckout?.skipUpdateWhenOutsideSparse).toBe(true);

    expect(byName.get("active-development")?.trash).toEqual({
      enabled: true,
      retentionDays: 14,
      warnSizeBytes: 5368709120,
      migrateLegacy: true,
    });

    // The two inactivity timeouts, which the loader dropped until they were
    // propagated: the drop guard above only proves the keys survive, so read
    // the values back off the resolved config the services receive.
    expect(byName.get("large-media-project")?.fetchTimeoutMs).toBe(900000);
    expect(byName.get("game-platform")?.cloneTimeoutMs).toBe(1800000);
    // Neither is set globally: a repository that says nothing keeps the
    // built-in default, which is `undefined` here and resolved in the service.
    expect(byName.get("documentation")?.fetchTimeoutMs).toBeUndefined();
    expect(byName.get("documentation")?.cloneTimeoutMs).toBeUndefined();
  });

  /**
   * The checks above only reach values the example SETS. Half of what it
   * documents is prose — the defaults a copied setting falls back to — and a
   * wrong number there misleads exactly the reader the file exists for. These
   * pin that prose to the constants it is describing, so a changed default
   * fails here instead of quietly making the reference wrong.
   */
  it("quotes the defaults it documents straight from the constants", async () => {
    const source = await fs.readFile(EXAMPLE_CONFIG_PATH, "utf-8");

    // The inactivity timeouts are shown commented out under `defaults`, each
    // line carrying the value it would set and the default it restates. Both
    // halves are pinned, so neither can drift away from the constant.
    expect(source).toContain(
      `// fetchTimeoutMs: ${DEFAULT_CONFIG.FETCH_TIMEOUT_MS}, // Default: ${DEFAULT_CONFIG.FETCH_TIMEOUT_MS} ms = 5 min.`,
    );
    expect(source).toContain(
      `// cloneTimeoutMs: ${DEFAULT_CONFIG.CLONE_TIMEOUT_MS}, // Default: ${DEFAULT_CONFIG.CLONE_TIMEOUT_MS} ms = 15 min.`,
    );
    expect(DEFAULT_CONFIG.FETCH_TIMEOUT_MS).toBe(5 * 60_000);
    expect(DEFAULT_CONFIG.CLONE_TIMEOUT_MS).toBe(15 * 60_000);

    // The trash block sets a non-default retentionDays on purpose, so the
    // default is only ever stated in the comment beside it.
    expect(source).toContain(`Default: ${DEFAULT_CONFIG.TRASH.RETENTION_DAYS}. Days an entry is kept`);
    expect(source).toContain(`enabled: true, // Default: ${String(DEFAULT_CONFIG.TRASH.ENABLED)}.`);
    expect(source).toContain(`migrateLegacy: true, // Default: ${String(DEFAULT_CONFIG.TRASH.MIGRATE_LEGACY)}.`);
  });

  it("names every clone-mode conflicting field in its clone-mode section", async () => {
    const source = await fs.readFile(EXAMPLE_CONFIG_PATH, "utf-8");

    // This enumeration went stale once already: `trash` joined
    // CLONE_MODE_CONFLICTING_FIELDS and the comment kept listing five fields,
    // so the example told clone-mode readers a rejected key was fine. Read the
    // bullet itself rather than the whole file — a name mentioned somewhere
    // else in 450 lines is not this list.
    const bullet = /- Conflicts with([\s\S]*?)is a validation error\./.exec(source);
    expect(bullet).not.toBeNull();

    const listed = CLONE_MODE_CONFLICTING_FIELDS.filter((field) => bullet![1].includes(field));
    expect(listed).toEqual([...CLONE_MODE_CONFLICTING_FIELDS]);
  });

  it("describes the clone-mode lock file where lock-path.ts actually puts it", async () => {
    const source = await fs.readFile(EXAMPLE_CONFIG_PATH, "utf-8");
    const { repositories } = await configLoader.buildRepositories(EXAMPLE_CONFIG_PATH);

    const cloneRepo = repositories.find((repo) => repo.mode === "clone");
    expect(cloneRepo).toBeDefined();

    const target = getWorktreeDirLockTarget(cloneRepo as RepositoryConfig);
    const lockDirName = path.basename(target.dir);

    // Sibling of the checkout, never inside it.
    expect(path.relative(cloneRepo!.worktreeDir, target.dir).startsWith("..")).toBe(true);
    expect(target.file).toMatch(/^[0-9a-f]{16}\.lock$/);

    expect(source).toContain(`<parent of worktreeDir>/${lockDirName}/<hash>.lock`);
    expect(source).toContain("first 16 hex characters of sha256");
    expect(source).toContain(ENV_CONSTANTS.LOCK_DIR);
    // The pre-T31 comment claimed the lock lived in the config file's state
    // directory, which is where the removal audit log lives instead.
    expect(source).not.toContain(".sync-worktrees-state");
  });
});
