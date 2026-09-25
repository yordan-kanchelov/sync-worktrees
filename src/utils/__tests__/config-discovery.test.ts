import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONFIG_PATH_ENV_VAR, describeConfigPath, findConfigUpTree, resolveConfigPath } from "../config-discovery";

describe("config discovery", () => {
  let tempDir: string;
  let home: string;
  let project: string;
  let nested: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-discovery-")));
    home = path.join(tempDir, "home", "me");
    project = path.join(home, "code", "project");
    nested = path.join(project, "packages", "app", "src");
    await fs.mkdir(nested, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(dir: string, name = "sync-worktrees.config.js"): Promise<string> {
    const file = path.join(dir, name);
    await fs.writeFile(file, "export default { repositories: [] };\n");
    return file;
  }

  describe("findConfigUpTree", () => {
    it("finds a config in the start directory", async () => {
      const config = await writeConfig(nested);
      expect(await findConfigUpTree(nested, home)).toBe(config);
    });

    it("walks up to the nearest parent that has one", async () => {
      await writeConfig(home);
      const nearest = await writeConfig(project);
      expect(await findConfigUpTree(nested, home)).toBe(nearest);
    });

    it("keeps the per-directory order: .js before .ts in the same directory", async () => {
      await writeConfig(project, "sync-worktrees.config.ts");
      const js = await writeConfig(project, "sync-worktrees.config.js");
      expect(await findConfigUpTree(nested, home)).toBe(js);
    });

    it("checks the home directory itself", async () => {
      const config = await writeConfig(home);
      expect(await findConfigUpTree(nested, home)).toBe(config);
    });

    // Like a git ceiling directory: a config in /home, or one somebody left
    // at the filesystem root, is not something a project under ~ meant to use.
    it("does not walk above the home directory when it started inside it", async () => {
      await writeConfig(path.dirname(home));
      await writeConfig(tempDir);
      expect(await findConfigUpTree(nested, home)).toBeNull();
    });

    it("walks past the home boundary when the start is outside home", async () => {
      const config = await writeConfig(tempDir);
      const elsewhere = path.join(tempDir, "builds", "job-1");
      await fs.mkdir(elsewhere, { recursive: true });
      expect(await findConfigUpTree(elsewhere, home)).toBe(config);
    });

    it("returns null when nothing up the tree has one", async () => {
      expect(await findConfigUpTree(nested, home)).toBeNull();
    });

    it("does not treat a sibling that shares a name prefix with home as inside it", async () => {
      const sibling = path.join(tempDir, "home", "me-too", "work");
      await fs.mkdir(sibling, { recursive: true });
      const config = await writeConfig(path.join(tempDir, "home"));
      expect(await findConfigUpTree(sibling, home)).toBe(config);
    });
  });

  describe("resolveConfigPath", () => {
    it("prefers --config over the environment and discovery", async () => {
      await writeConfig(project);
      const resolved = await resolveConfigPath("custom.config.js", {
        cwd: nested,
        env: { [CONFIG_PATH_ENV_VAR]: "/elsewhere/env.config.js" },
        homeDir: home,
      });
      expect(resolved).toEqual({ path: path.join(nested, "custom.config.js"), source: "flag" });
    });

    it("prefers SYNC_WORKTREES_CONFIG over discovery, resolved against cwd", async () => {
      await writeConfig(project);
      const resolved = await resolveConfigPath(undefined, {
        cwd: nested,
        env: { [CONFIG_PATH_ENV_VAR]: "../shared.config.js" },
        homeDir: home,
      });
      expect(resolved).toEqual({ path: path.join(path.dirname(nested), "shared.config.js"), source: "env" });
    });

    it("returns the env path even when the file is missing, so the caller can name the variable", async () => {
      const resolved = await resolveConfigPath(undefined, {
        cwd: nested,
        env: { [CONFIG_PATH_ENV_VAR]: "/does/not/exist.js" },
        homeDir: home,
      });
      expect(resolved).toEqual({ path: "/does/not/exist.js", source: "env" });
    });

    it("treats an empty or blank variable as unset", async () => {
      const config = await writeConfig(project);
      for (const value of ["", "   "]) {
        const resolved = await resolveConfigPath(undefined, {
          cwd: nested,
          env: { [CONFIG_PATH_ENV_VAR]: value },
          homeDir: home,
        });
        expect(resolved).toEqual({ path: config, source: "discovered" });
      }
    });

    it("falls back to discovery and returns null when that finds nothing", async () => {
      expect(await resolveConfigPath(undefined, { cwd: nested, env: {}, homeDir: home })).toBeNull();
    });
  });

  describe("describeConfigPath", () => {
    it("shows a flag path relative to cwd with no note", () => {
      expect(describeConfigPath({ path: path.join(project, "a.config.js"), source: "flag" }, project)).toBe(
        "a.config.js",
      );
    });

    it("notes a config found in a parent directory", () => {
      const config = path.join(project, "sync-worktrees.config.js");
      expect(describeConfigPath({ path: config, source: "discovered" }, nested)).toBe(
        `${path.relative(nested, config)} (found in a parent directory)`,
      );
    });

    it("adds no note for a config discovered in cwd itself", () => {
      const config = path.join(nested, "sync-worktrees.config.js");
      expect(describeConfigPath({ path: config, source: "discovered" }, nested)).toBe("sync-worktrees.config.js");
    });

    it("names the variable and keeps an absolute path when the relative one is longer", () => {
      expect(describeConfigPath({ path: "/etc/sw.js", source: "env" }, nested)).toBe(
        `/etc/sw.js (from ${CONFIG_PATH_ENV_VAR})`,
      );
    });
  });
});
