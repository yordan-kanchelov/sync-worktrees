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
  confirm: jest.fn(),
}));

// Mock the config generator
jest.mock("../config-generator", () => ({
  generateConfigFile: jest.fn(),
  getDefaultConfigPath: jest.fn(() => "/default/config.js"),
}));

describe("Interactive prompt utility", () => {
  const mockExistsSync = jest.mocked(fs.existsSync);

  // Get the mocked functions with proper typing
  const { input, select, confirm } = jest.requireMock("@inquirer/prompts") as {
    input: jest.MockedFunction<(options: any) => Promise<string>>;
    select: jest.MockedFunction<(options: any) => Promise<string>>;
    confirm: jest.MockedFunction<(options: any) => Promise<boolean>>;
  };

  const { generateConfigFile } = jest.requireMock("../config-generator") as {
    generateConfigFile: jest.MockedFunction<(config: any, path: string) => Promise<void>>;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockExistsSync.mockReturnValue(true);
    // Default to not saving config in tests
    confirm.mockResolvedValue(false);
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

    it("should validate empty repository path", async () => {
      input
        .mockResolvedValueOnce("/path/to/repo") // repoPath
        .mockResolvedValueOnce("/path/to/worktrees"); // worktreeDir

      select.mockResolvedValueOnce("once"); // runMode

      await promptForConfig({});

      const validateFn = (input as any).mock.calls[0][0].validate;

      // Test validation
      expect(validateFn("")).toBe("Repository path is required");
      expect(validateFn("   ")).toBe("Repository path is required");
      expect(validateFn("/valid/path")).toBe(true);
    });

    it("should validate empty worktree directory", async () => {
      input
        .mockResolvedValueOnce("/path/to/repo") // repoPath
        .mockResolvedValueOnce("/path/to/worktrees"); // worktreeDir

      select.mockResolvedValueOnce("once"); // runMode

      await promptForConfig({});

      const validateFn = (input as any).mock.calls[1][0].validate;

      // Test validation
      expect(validateFn("")).toBe("Worktree directory is required");
      expect(validateFn("   ")).toBe("Worktree directory is required");
      expect(validateFn("/valid/path")).toBe(true);
    });

    it("should validate repository URL when path doesn't exist", async () => {
      mockExistsSync.mockReturnValue(false);

      input
        .mockResolvedValueOnce("/new/repo") // repoPath
        .mockResolvedValueOnce("https://github.com/user/repo.git") // repoUrl
        .mockResolvedValueOnce("/worktrees"); // worktreeDir

      select.mockResolvedValueOnce("once"); // runMode

      await promptForConfig({});

      const validateFn = (input as any).mock.calls[1][0].validate;

      // Test validation
      expect(validateFn("")).toBe("Repository URL is required since the repository path doesn't exist");
      expect(validateFn("   ")).toBe("Repository URL is required since the repository path doesn't exist");
      expect(validateFn("https://github.com/user/repo.git")).toBe(true);
    });

    it("should validate cron schedule format", async () => {
      select.mockResolvedValueOnce("scheduled"); // runMode

      input.mockResolvedValueOnce("*/5 * * * *"); // cronSchedule

      await promptForConfig({
        repoPath: "/repo",
        worktreeDir: "/worktrees",
      });

      const validateFn = (input as any).mock.calls[0][0].validate;

      // Test validation
      expect(validateFn("")).toBe("Cron schedule is required");
      expect(validateFn("   ")).toBe("Cron schedule is required");
      expect(validateFn("invalid")).toBe("Invalid cron pattern. Expected format: '* * * * *'");
      expect(validateFn("* * * *")).toBe("Invalid cron pattern. Expected format: '* * * * *'");
      expect(validateFn("* * * * *")).toBe(true);
      expect(validateFn("0 */5 * * *")).toBe(true);
    });

    it("should not prompt for repo URL when path exists", async () => {
      mockExistsSync.mockReturnValue(true);

      input.mockResolvedValueOnce("/worktrees"); // worktreeDir only

      select.mockResolvedValueOnce("once"); // runMode

      const result = await promptForConfig({
        repoPath: "/existing/repo",
      });

      expect(input).toHaveBeenCalledTimes(1); // Only worktreeDir
      expect(result.repoUrl).toBeUndefined();
    });

    it("should handle all fields provided", async () => {
      const result = await promptForConfig({
        repoPath: "/repo",
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/worktrees",
        cronSchedule: "0 0 * * *",
        runOnce: false,
      });

      // Should not prompt for anything
      expect(input).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();

      expect(result).toEqual({
        repoPath: "/repo",
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/worktrees",
        cronSchedule: "0 0 * * *",
        runOnce: false,
      });
    });

    it("should prompt to save config file", async () => {
      confirm.mockResolvedValueOnce(true); // saveConfig
      input
        .mockResolvedValueOnce("/repo") // repoPath
        .mockResolvedValueOnce("/worktrees") // worktreeDir
        .mockResolvedValueOnce("/custom/config.js"); // configPath

      select.mockResolvedValueOnce("once"); // runMode

      await promptForConfig({});

      expect(confirm).toHaveBeenCalledWith({
        message: "Would you like to save this configuration to a file for future use?",
        default: true,
      });
      expect(input).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Enter the path for the config file:",
          default: "/default/config.js",
        }),
      );
      expect(generateConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: "/repo",
          worktreeDir: "/worktrees",
        }),
        "/custom/config.js",
      );
    });

    it("should handle config file save errors", async () => {
      confirm.mockResolvedValueOnce(true); // saveConfig
      generateConfigFile.mockRejectedValueOnce(new Error("Write failed"));

      input
        .mockResolvedValueOnce("/repo") // repoPath
        .mockResolvedValueOnce("/worktrees") // worktreeDir
        .mockResolvedValueOnce("/custom/config.js"); // configPath

      select.mockResolvedValueOnce("once"); // runMode

      const result = await promptForConfig({});

      expect(generateConfigFile).toHaveBeenCalled();
      expect(result).toEqual({
        repoPath: "/repo",
        worktreeDir: "/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: true,
        repoUrl: undefined,
      });
    });
  });
});
