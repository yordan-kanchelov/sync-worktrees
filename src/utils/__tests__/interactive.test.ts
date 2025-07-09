import * as fs from "fs";
import * as path from "path";

import { confirm, input, select } from "@inquirer/prompts";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

import { generateConfigFile } from "../config-generator";
import { promptForConfig } from "../interactive";

import type { Config } from "../../types";

// Mock the modules
jest.mock("@inquirer/prompts", () => ({
  input: jest.fn(),
  select: jest.fn(),
  confirm: jest.fn(),
}));

jest.mock("../config-generator", () => ({
  generateConfigFile: jest.fn(),
  getDefaultConfigPath: jest.fn().mockReturnValue("/default/config.js"),
}));

jest.mock("fs", () => ({
  existsSync: jest.fn(),
}));

describe("Interactive", () => {
  const mockInput = input as unknown as jest.MockedFunction<typeof input>;
  const mockSelect = select as unknown as jest.MockedFunction<typeof select>;
  const mockConfirm = confirm as unknown as jest.MockedFunction<typeof confirm>;
  const mockGenerateConfigFile = generateConfigFile as jest.MockedFunction<typeof generateConfigFile>;
  const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;

  const cwd = process.cwd();

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock console methods to avoid noise in tests
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockExistsSync.mockReturnValue(true);
    // Default to not saving config in tests
    mockConfirm.mockResolvedValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("promptForConfig", () => {
    it("should prompt for all missing fields", async () => {
      mockInput
        .mockResolvedValueOnce("https://github.com/user/repo.git") // repoUrl
        .mockResolvedValueOnce("/path/to/worktrees") // worktreeDir
        .mockResolvedValueOnce("*/10 * * * *"); // cronSchedule

      mockSelect.mockResolvedValueOnce("scheduled"); // runMode
      mockConfirm.mockResolvedValueOnce(false); // askForBareDir

      const result = await promptForConfig({});

      expect(mockInput).toHaveBeenCalledTimes(3);
      expect(mockSelect).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/path/to/worktrees",
        cronSchedule: "*/10 * * * *",
        runOnce: false,
        bareRepoDir: undefined,
      });
    });

    it("should not prompt for provided fields", async () => {
      const partialConfig = {
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/existing/worktrees",
      };

      mockSelect.mockResolvedValueOnce("once"); // runMode
      mockConfirm.mockResolvedValueOnce(false); // askForBareDir

      const result = await promptForConfig(partialConfig);

      expect(mockInput).not.toHaveBeenCalled();
      expect(mockSelect).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/existing/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: true,
        bareRepoDir: undefined,
      });
    });

    it("should prompt for custom bare repo directory when requested", async () => {
      mockInput
        .mockResolvedValueOnce("https://github.com/user/repo.git") // repoUrl
        .mockResolvedValueOnce("/path/to/worktrees") // worktreeDir
        .mockResolvedValueOnce("/custom/bare/location"); // bareRepoDir

      mockSelect.mockResolvedValueOnce("once"); // runMode
      mockConfirm
        .mockResolvedValueOnce(true) // askForBareDir
        .mockResolvedValueOnce(false); // save config

      const result = await promptForConfig({});

      expect(result).toEqual({
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/path/to/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: true,
        bareRepoDir: "/custom/bare/location",
      });
    });

    it("should resolve relative paths to absolute paths", async () => {
      mockInput
        .mockResolvedValueOnce("git@github.com:user/repo.git") // repoUrl
        .mockResolvedValueOnce("./my-worktrees"); // worktreeDir (relative)

      mockSelect.mockResolvedValueOnce("once"); // runMode
      mockConfirm.mockResolvedValueOnce(false); // askForBareDir

      const result = await promptForConfig({});

      expect(result.worktreeDir).toBe(path.resolve(cwd, "./my-worktrees"));
    });

    it("should use repository name as default worktree directory", async () => {
      mockInput
        .mockResolvedValueOnce("https://github.com/user/my-awesome-repo.git") // repoUrl
        .mockResolvedValueOnce(""); // worktreeDir (empty to use default)

      mockSelect.mockResolvedValueOnce("once"); // runMode
      mockConfirm.mockResolvedValueOnce(false); // askForBareDir

      const result = await promptForConfig({});

      // Verify the input was called with the correct default
      expect(mockInput).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Enter the directory for storing worktrees:",
          default: "./my-awesome-repo",
        }),
      );

      expect(result.worktreeDir).toBe(path.resolve(cwd, "./my-awesome-repo"));
    });

    it("should handle SSH URLs for default worktree directory", async () => {
      mockInput
        .mockResolvedValueOnce("ssh://git@bitbucket.tech.amusnet.io/lc/live-casino-monorepo.git") // repoUrl
        .mockResolvedValueOnce(""); // worktreeDir (empty to use default)

      mockSelect.mockResolvedValueOnce("once"); // runMode
      mockConfirm.mockResolvedValueOnce(false); // askForBareDir

      const result = await promptForConfig({});

      // Verify the input was called with the correct default
      expect(mockInput).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Enter the directory for storing worktrees:",
          default: "./live-casino-monorepo",
        }),
      );

      expect(result.worktreeDir).toBe(path.resolve(cwd, "./live-casino-monorepo"));
    });

    it("should save config file when requested", async () => {
      const partialConfig: Partial<Config> = {
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/path/to/worktrees",
        runOnce: true,
      };

      mockConfirm
        .mockResolvedValueOnce(false) // askForBareDir
        .mockResolvedValueOnce(true); // save config

      mockInput.mockResolvedValueOnce("/custom/config.js"); // config path

      const result = await promptForConfig(partialConfig);

      expect(mockConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("save this configuration"),
        }),
      );

      expect(mockInput).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("path for the config file"),
          default: "/default/config.js",
        }),
      );

      expect(mockGenerateConfigFile).toHaveBeenCalledWith(result, "/custom/config.js");
    });

    it("should validate URL format", async () => {
      // First trigger a prompt to capture the validation function
      mockInput.mockResolvedValueOnce("https://github.com/user/repo.git").mockResolvedValueOnce("/path/to/worktrees");
      mockSelect.mockResolvedValueOnce("once");
      mockConfirm.mockResolvedValueOnce(false);

      await promptForConfig({});

      const validateFn = mockInput.mock.calls.find((call) => call[0].message?.includes("repository URL"))?.[0].validate;

      expect(validateFn).toBeDefined();
      if (validateFn) {
        expect(validateFn("")).toBe("Repository URL is required");
        expect(validateFn("not-a-url")).toBe("Please enter a valid Git URL (https://, ssh://, git@, or file://)");
        expect(validateFn("https://github.com/user/repo.git")).toBe(true);
        expect(validateFn("git@github.com:user/repo.git")).toBe(true);
        expect(validateFn("file:///local/repo.git")).toBe(true);
        expect(validateFn("ssh://git@github.com/user/repo.git")).toBe(true);
      }
    });

    it("should handle error when saving config file fails", async () => {
      const partialConfig: Partial<Config> = {
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/path/to/worktrees",
      };

      mockSelect.mockResolvedValueOnce("once");
      mockConfirm
        .mockResolvedValueOnce(false) // askForBareDir
        .mockResolvedValueOnce(true); // save config

      mockInput.mockResolvedValueOnce("/fail/config.js");

      mockGenerateConfigFile.mockRejectedValueOnce(new Error("Write failed"));

      const result = await promptForConfig(partialConfig);

      expect(result).toEqual({
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/path/to/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: true,
        bareRepoDir: undefined,
      });

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Failed to save config file"));
    });
  });
});
