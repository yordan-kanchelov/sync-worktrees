import * as fs from "fs";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

import { promptForConfig } from "../interactive";

// Mock fs module
jest.mock("fs");

// Mock the inquirer prompts
jest.mock("@inquirer/prompts", () => ({
  input: jest.fn(),
  select: jest.fn(),
}));

describe("Interactive prompt utility", () => {
  const mockExistsSync = jest.mocked(fs.existsSync);

  // Get the mocked functions with proper typing
  const { input, select } = jest.requireMock("@inquirer/prompts") as {
    input: jest.MockedFunction<() => Promise<string>>;
    select: jest.MockedFunction<() => Promise<string>>;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("promptForConfig", () => {
    it("should prompt for all missing fields", async () => {
      input
        .mockResolvedValueOnce("/path/to/repo") // repoPath
        .mockResolvedValueOnce("/path/to/worktrees") // worktreeDir
        .mockResolvedValueOnce("*/10 * * * *"); // cronSchedule

      select.mockResolvedValueOnce("scheduled"); // runMode

      const result = await promptForConfig({});

      expect(input).toHaveBeenCalledTimes(3);
      expect(select).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        repoPath: "/path/to/repo",
        repoUrl: undefined,
        worktreeDir: "/path/to/worktrees",
        cronSchedule: "*/10 * * * *",
        runOnce: false,
      });
    });

    it("should not prompt for provided fields", async () => {
      const partialConfig = {
        repoPath: "/existing/repo",
        worktreeDir: "/existing/worktrees",
      };

      select.mockResolvedValueOnce("once"); // runMode

      const result = await promptForConfig(partialConfig);

      expect(input).not.toHaveBeenCalled();
      expect(select).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        repoPath: "/existing/repo",
        repoUrl: undefined,
        worktreeDir: "/existing/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: true,
      });
    });

    it("should prompt for repo URL when repo path doesn't exist", async () => {
      mockExistsSync.mockReturnValue(false);

      input
        .mockResolvedValueOnce("/new/repo") // repoPath
        .mockResolvedValueOnce("https://github.com/user/repo.git") // repoUrl
        .mockResolvedValueOnce("/worktrees"); // worktreeDir

      select.mockResolvedValueOnce("once"); // runMode

      const result = await promptForConfig({});

      expect(input).toHaveBeenCalledTimes(3);
      expect(result.repoUrl).toBe("https://github.com/user/repo.git");
    });

    it("should convert relative paths to absolute paths", async () => {
      const cwd = process.cwd();

      input
        .mockResolvedValueOnce("./my-repo") // repoPath (relative)
        .mockResolvedValueOnce("../worktrees"); // worktreeDir (relative)

      select.mockResolvedValueOnce("once"); // runMode

      const result = await promptForConfig({});

      expect(result.repoPath).toBe(path.resolve(cwd, "./my-repo"));
      expect(result.worktreeDir).toBe(path.resolve(cwd, "../worktrees"));
    });

    it("should not prompt for cron schedule when runOnce is true", async () => {
      select.mockResolvedValueOnce("once"); // runMode

      const result = await promptForConfig({
        repoPath: "/repo",
        worktreeDir: "/worktrees",
      });

      // Should not prompt for cronSchedule
      expect(input).not.toHaveBeenCalled();
      expect(result.runOnce).toBe(true);
      expect(result.cronSchedule).toBe("0 * * * *"); // default value
    });

    it("should use provided runOnce value", async () => {
      const result = await promptForConfig({
        repoPath: "/repo",
        worktreeDir: "/worktrees",
        runOnce: true,
      });

      // Should not prompt for runMode
      expect(select).not.toHaveBeenCalled();
      expect(result.runOnce).toBe(true);
    });

    it("should use provided cronSchedule", async () => {
      select.mockResolvedValueOnce("scheduled"); // runMode

      const result = await promptForConfig({
        repoPath: "/repo",
        worktreeDir: "/worktrees",
        cronSchedule: "0 0 * * *",
      });

      // Should not prompt for cronSchedule
      expect(input).not.toHaveBeenCalled();
      expect(result.cronSchedule).toBe("0 0 * * *");
    });
  });
});
