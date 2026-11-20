import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setEnvVar } from "../../__tests__/test-utils";
import { DEFAULT_CONFIG, ENV_CONSTANTS } from "../../constants";
import { getWorktreeDirLockTarget } from "../../utils/lock-path";
import { collectUnknownConfigKeys } from "../../utils/unknown-config-keys";
import { KNOWN_CONFIG_KEYS } from "../config-schema";
import { ConfigLoaderService } from "../config-loader.service";
import { CLONE_MODE_CONFLICTING_FIELDS } from "../config-schema";

import type { RepositoryConfig } from "../../types";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../..");
const EXAMPLE_CONFIG_PATH = path.join(REPO_ROOT, "sync-worktrees.config.example.js");

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
    setEnvVar(ENV_CONSTANTS.LOCK_DIR, undefined);
  });

  afterEach(() => {
    setEnvVar(ENV_CONSTANTS.LOCK_DIR, originalLockDir);
  });

  it("loads cleanly and resolves every documented repository", async () => {
    const { repositories, configFile } = await configLoader.buildRepositories(EXAMPLE_CONFIG_PATH);

    expect(repositories.map((repo) => repo.name)).toEqual(EXAMPLE_REPOSITORY_NAMES);
    expect(repositories).toHaveLength(EXAMPLE_REPOSITORY_NAMES.length);

    expect(configFile.defaults?.runOnce).toBe(false);
    for (const repo of configFile.repositories) {
      expect(Object.prototype.hasOwnProperty.call(repo, "runOnce")).toBe(false);
    }
  });

  it("sets no key that the loader drops on the floor", async () => {
    const { repositories, configFile } = await configLoader.buildRepositories(EXAMPLE_CONFIG_PATH);
    const resolvedByName = new Map<string, RepositoryConfig>(repositories.map((repo) => [repo.name, repo]));

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

  it("sets no key the loader reports as unknown", async () => {
    const configFile = (await configLoader.loadConfigFile(EXAMPLE_CONFIG_PATH)) as unknown as Record<string, unknown>;

    expect(collectUnknownConfigKeys(configFile, KNOWN_CONFIG_KEYS)).toEqual([]);
  });

  it("resolves the nested knobs the README promises", async () => {
    const { repositories } = await configLoader.buildRepositories(EXAMPLE_CONFIG_PATH);
    const byName = new Map<string, RepositoryConfig>(repositories.map((repo) => [repo.name, repo]));

    const topLevelBlocksReachRepos = byName.get("my-main-project");
    expect(topLevelBlocksReachRepos?.parallelism?.maxWorktreeUpdates).toBe(3);
    expect(topLevelBlocksReachRepos?.parallelism?.maxStatusChecks).toBe(20);
    expect(topLevelBlocksReachRepos?.retry?.jitterMs).toBe(500);

    expect(byName.get("monorepo-game-client")?.sparseCheckout?.skipUpdateWhenOutsideSparse).toBe(true);

    expect(byName.get("active-development")?.trash).toEqual({
      enabled: true,
      retentionDays: 14,
      warnSizeBytes: 5368709120,
      migrateLegacy: true,
    });

    expect(byName.get("large-media-project")?.fetchTimeoutMs).toBe(900000);
    expect(byName.get("game-platform")?.cloneTimeoutMs).toBe(1800000);
    expect(byName.get("documentation")?.fetchTimeoutMs).toBeUndefined();
    expect(byName.get("documentation")?.cloneTimeoutMs).toBeUndefined();
  });

  it("quotes the defaults it documents straight from the constants", async () => {
    const source = await fs.readFile(EXAMPLE_CONFIG_PATH, "utf-8");

    expect(source).toContain(
      `// fetchTimeoutMs: ${DEFAULT_CONFIG.FETCH_TIMEOUT_MS}, // Default: ${DEFAULT_CONFIG.FETCH_TIMEOUT_MS} ms = 5 min.`,
    );
    expect(source).toContain(
      `// cloneTimeoutMs: ${DEFAULT_CONFIG.CLONE_TIMEOUT_MS}, // Default: ${DEFAULT_CONFIG.CLONE_TIMEOUT_MS} ms = 15 min.`,
    );
    expect(DEFAULT_CONFIG.FETCH_TIMEOUT_MS).toBe(5 * 60_000);
    expect(DEFAULT_CONFIG.CLONE_TIMEOUT_MS).toBe(15 * 60_000);

    expect(source).toContain(`Default: ${DEFAULT_CONFIG.TRASH.RETENTION_DAYS}. Days an entry is kept`);
    expect(source).toContain(`enabled: true, // Default: ${String(DEFAULT_CONFIG.TRASH.ENABLED)}.`);
    expect(source).toContain(`migrateLegacy: true, // Default: ${String(DEFAULT_CONFIG.TRASH.MIGRATE_LEGACY)}.`);
  });

  it("names every clone-mode conflicting field in its clone-mode section", async () => {
    const source = await fs.readFile(EXAMPLE_CONFIG_PATH, "utf-8");

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

    expect(path.relative(cloneRepo!.worktreeDir, target.dir).startsWith("..")).toBe(true);
    expect(target.file).toMatch(/^[0-9a-f]{16}\.lock$/);

    expect(source).toContain(`<parent of worktreeDir>/${lockDirName}/<hash>.lock`);
    expect(source).toContain("first 16 hex characters of sha256");
    expect(source).toContain(ENV_CONSTANTS.LOCK_DIR);
  });
});
