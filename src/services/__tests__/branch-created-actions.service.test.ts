import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BranchCreatedActionsService } from "../branch-created-actions.service";
import { FileCopyService } from "../file-copy.service";
import { Logger } from "../logger.service";

import type { Config } from "../../types";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    repoUrl: "https://github.com/acme/api.git",
    worktreeDir: "/ws/api",
    cronSchedule: "0 * * * *",
    runOnce: true,
    ...overrides,
  };
}

describe("BranchCreatedActionsService.copyFiles", () => {
  const logger = new Logger({ outputFn: () => {} });

  describe("exclusion list", () => {
    it("names the destination and every directory the config file hands to a repository", async () => {
      const fileCopyService = new FileCopyService();
      const spy = vi.spyOn(fileCopyService, "copyFiles").mockResolvedValue({ copied: [], skipped: [], errors: [] });

      await new BranchCreatedActionsService(fileCopyService).copyFiles({
        config: makeConfig({
          filesToCopyOnBranchCreate: ["**/.env"],
          __configuredRepoDirs: ["/ws/api", "/ws/web", "/ws/.bare/tools"],
        }),
        branchName: "feature",
        worktreePath: "/ws/api/feature",
        sourceDir: "/ws/api/main",
        logger,
      });

      expect(spy.mock.calls[0][3]?.excludeDirs).toEqual(["/ws/api/feature", "/ws/api", "/ws/web", "/ws/.bare/tools"]);
    });

    it("falls back to the repository's own directories, without repeating the destination", async () => {
      const fileCopyService = new FileCopyService();
      const spy = vi.spyOn(fileCopyService, "copyFiles").mockResolvedValue({ copied: [], skipped: [], errors: [] });

      await new BranchCreatedActionsService(fileCopyService).copyFiles({
        config: makeConfig({ filesToCopyOnBranchCreate: ["**/.env"], bareRepoDir: "/ws/.bare/api" }),
        branchName: "feature",
        worktreePath: "/ws/api",
        sourceDir: "/ws",
        logger,
      });

      expect(spy.mock.calls[0][3]?.excludeDirs).toEqual(["/ws/api", "/ws/.bare/api"]);
    });
  });

  describe("on a real tree", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "branch-created-actions-"));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("clone mode: keeps a sibling checkout's file out of the new clone", async () => {
      // The documented quick-start layout: the config file's directory is the
      // parent of every clone-mode checkout.
      await fs.mkdir(path.join(tempDir, "api"), { recursive: true });
      await fs.mkdir(path.join(tempDir, "web"), { recursive: true });
      await fs.writeFile(path.join(tempDir, ".env.local"), "shared");
      await fs.writeFile(path.join(tempDir, "api", ".env.local"), "API_SECRET=1");

      await new BranchCreatedActionsService().copyFiles({
        config: makeConfig({
          worktreeDir: path.join(tempDir, "web"),
          filesToCopyOnBranchCreate: ["**/.env.local"],
          __configuredRepoDirs: [path.join(tempDir, "api"), path.join(tempDir, "web")],
        }),
        branchName: "main",
        worktreePath: path.join(tempDir, "web"),
        sourceDir: tempDir,
        logger,
      });

      await expect(fs.readFile(path.join(tempDir, "web", ".env.local"), "utf-8")).resolves.toBe("shared");
      await expect(fs.stat(path.join(tempDir, "web", "api", ".env.local"))).rejects.toThrow();
    });

    it("clone mode: keeps a sibling checkout out when its configured directory is a symlink", async () => {
      // `worktreeDir: <config dir>/api` where that name is a symlink onto
      // another disk, plus a `current -> api` alias next to it. A single-star
      // pattern resolves through both.
      await fs.mkdir(path.join(tempDir, "disk2", "api"), { recursive: true });
      await fs.mkdir(path.join(tempDir, "ws", "web"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "disk2", "api", ".env.local"), "API_SECRET=1");
      await fs.writeFile(path.join(tempDir, "ws", ".env.local"), "shared");
      await fs.symlink(path.join(tempDir, "disk2", "api"), path.join(tempDir, "ws", "api"));
      await fs.symlink(path.join(tempDir, "ws", "api"), path.join(tempDir, "ws", "current"));

      await new BranchCreatedActionsService().copyFiles({
        config: makeConfig({
          worktreeDir: path.join(tempDir, "ws", "web"),
          filesToCopyOnBranchCreate: ["**/.env.local", "*/.env.local"],
          __configuredRepoDirs: [path.join(tempDir, "ws", "api"), path.join(tempDir, "ws", "web")],
        }),
        branchName: "main",
        worktreePath: path.join(tempDir, "ws", "web"),
        sourceDir: path.join(tempDir, "ws"),
        logger,
      });

      const dest = path.join(tempDir, "ws", "web");
      await expect(fs.readFile(path.join(dest, ".env.local"), "utf-8")).resolves.toBe("shared");
      await expect(fs.stat(path.join(dest, "api"))).rejects.toThrow();
      await expect(fs.stat(path.join(dest, "current"))).rejects.toThrow();
    });

    it("clone mode: keeps a sibling checkout out when an ordinary alias names its parent", async () => {
      // Checkouts under a `repos/` directory with a `current -> repos`
      // convenience symlink beside them. The alias resolves to the parent
      // rather than to a checkout, so `current/api` is an ordinary directory
      // under a name the config file never spelled.
      await fs.mkdir(path.join(tempDir, "repos", "api"), { recursive: true });
      await fs.mkdir(path.join(tempDir, "repos", "web"), { recursive: true });
      await fs.writeFile(path.join(tempDir, ".env.local"), "shared");
      await fs.writeFile(path.join(tempDir, "repos", "api", ".env.local"), "API_SECRET=1");
      await fs.symlink(path.join(tempDir, "repos"), path.join(tempDir, "current"));

      const dest = path.join(tempDir, "repos", "web");
      await new BranchCreatedActionsService().copyFiles({
        config: makeConfig({
          worktreeDir: dest,
          filesToCopyOnBranchCreate: ["**/.env.local", "*/*/.env.local"],
          __configuredRepoDirs: [path.join(tempDir, "repos", "api"), dest],
        }),
        branchName: "main",
        worktreePath: dest,
        sourceDir: tempDir,
        logger,
      });

      await expect(fs.readFile(path.join(dest, ".env.local"), "utf-8")).resolves.toBe("shared");
      await expect(fs.stat(path.join(dest, "current"))).rejects.toThrow();
    });

    it("worktree mode: still copies from a symlinked directory inside the source worktree", async () => {
      // The source worktree sits inside this repository's own worktreeDir,
      // which the exclusion list names — so the walk must not read that entry
      // as "everything under the source is foreign".
      const source = path.join(tempDir, "trees", "main-abc");
      await fs.mkdir(path.join(source, "deep", "nested"), { recursive: true });
      await fs.writeFile(path.join(source, ".env.local"), "shared");
      await fs.writeFile(path.join(source, "deep", "nested", ".env.local"), "nested");
      await fs.symlink(path.join(source, "deep", "nested"), path.join(source, "alias"));

      const dest = path.join(tempDir, "trees", "feat");
      await new BranchCreatedActionsService().copyFiles({
        config: makeConfig({
          worktreeDir: path.join(tempDir, "trees"),
          bareRepoDir: path.join(tempDir, ".bare", "repo"),
          filesToCopyOnBranchCreate: [".env.local", "*/.env.local"],
          __configuredRepoDirs: [path.join(tempDir, "trees"), path.join(tempDir, ".bare", "repo")],
        }),
        branchName: "feat",
        worktreePath: dest,
        sourceDir: source,
        logger,
      });

      await expect(fs.readFile(path.join(dest, ".env.local"), "utf-8")).resolves.toBe("shared");
      await expect(fs.readFile(path.join(dest, "alias", ".env.local"), "utf-8")).resolves.toBe("nested");
    });

    it("worktree mode: keeps a nested repository's checkout out of the new worktree", async () => {
      // detectPathCollisions allows (and warns about) a worktreeDir nested
      // inside another repository's worktreeDir, which is the one shape that
      // puts a foreign checkout under a worktree-mode copy source.
      const source = path.join(tempDir, "api", "main");
      await fs.mkdir(path.join(source, "vendor", "tools"), { recursive: true });
      await fs.writeFile(path.join(source, ".env.local"), "shared");
      await fs.writeFile(path.join(source, "vendor", "tools", ".env.local"), "TOOLS_SECRET=1");

      await new BranchCreatedActionsService().copyFiles({
        config: makeConfig({
          worktreeDir: path.join(tempDir, "api"),
          filesToCopyOnBranchCreate: ["**/.env.local"],
          __configuredRepoDirs: [path.join(tempDir, "api"), path.join(source, "vendor", "tools")],
        }),
        branchName: "feature",
        worktreePath: path.join(tempDir, "api", "feature"),
        sourceDir: source,
        logger,
      });

      const dest = path.join(tempDir, "api", "feature");
      await expect(fs.readFile(path.join(dest, ".env.local"), "utf-8")).resolves.toBe("shared");
      await expect(fs.stat(path.join(dest, "vendor", "tools", ".env.local"))).rejects.toThrow();
    });
  });
});
