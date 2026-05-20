import * as path from "path";

import { confirm, input, select } from "@inquirer/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { promptForInitConfig } from "../interactive";

import type { MockedFunction } from "vitest";

vi.mock("@inquirer/prompts", () => ({
  input: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
}));

describe("promptForInitConfig", () => {
  const mockInput = input as unknown as MockedFunction<typeof input>;
  const mockSelect = select as unknown as MockedFunction<typeof select>;
  const mockConfirm = confirm as unknown as MockedFunction<typeof confirm>;

  const cwd = process.cwd();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prompts for repoUrl, worktreeDir, run mode + cron", async () => {
    mockInput
      .mockResolvedValueOnce("https://github.com/user/repo.git")
      .mockResolvedValueOnce("/path/to/worktrees")
      .mockResolvedValueOnce("*/10 * * * *");
    mockSelect.mockResolvedValueOnce("scheduled");
    mockConfirm.mockResolvedValueOnce(false);

    const result = await promptForInitConfig();

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

  it("skips cron prompt when runOnce selected", async () => {
    mockInput.mockResolvedValueOnce("https://github.com/user/repo.git").mockResolvedValueOnce("/path/to/worktrees");
    mockSelect.mockResolvedValueOnce("once");
    mockConfirm.mockResolvedValueOnce(false);

    const result = await promptForInitConfig();

    expect(mockInput).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      repoUrl: "https://github.com/user/repo.git",
      worktreeDir: "/path/to/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: true,
      bareRepoDir: undefined,
    });
  });

  it("prompts for custom bareRepoDir when requested", async () => {
    mockInput
      .mockResolvedValueOnce("https://github.com/user/repo.git")
      .mockResolvedValueOnce("/path/to/worktrees")
      .mockResolvedValueOnce("/custom/bare/location");
    mockSelect.mockResolvedValueOnce("once");
    mockConfirm.mockResolvedValueOnce(true);

    const result = await promptForInitConfig();

    expect(result.bareRepoDir).toBe("/custom/bare/location");
  });

  it("resolves relative paths to absolute", async () => {
    mockInput.mockResolvedValueOnce("git@github.com:user/repo.git").mockResolvedValueOnce("./my-worktrees");
    mockSelect.mockResolvedValueOnce("once");
    mockConfirm.mockResolvedValueOnce(false);

    const result = await promptForInitConfig();

    expect(result.worktreeDir).toBe(path.resolve(cwd, "./my-worktrees"));
  });

  it("uses repository name as default worktree directory", async () => {
    mockInput.mockResolvedValueOnce("https://github.com/user/my-awesome-repo.git").mockResolvedValueOnce("");
    mockSelect.mockResolvedValueOnce("once");
    mockConfirm.mockResolvedValueOnce(false);

    const result = await promptForInitConfig();

    expect(mockInput).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Enter the directory for storing worktrees:",
        default: "./my-awesome-repo",
      }),
    );

    expect(result.worktreeDir).toBe(path.resolve(cwd, "./my-awesome-repo"));
  });

  it("handles SSH URLs for default worktree directory", async () => {
    mockInput
      .mockResolvedValueOnce("ssh://git@bitbucket.tech.amusnet.io/lc/live-casino-monorepo.git")
      .mockResolvedValueOnce("");
    mockSelect.mockResolvedValueOnce("once");
    mockConfirm.mockResolvedValueOnce(false);

    const result = await promptForInitConfig();

    expect(mockInput).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Enter the directory for storing worktrees:",
        default: "./live-casino-monorepo",
      }),
    );

    expect(result.worktreeDir).toBe(path.resolve(cwd, "./live-casino-monorepo"));
  });

  it("validates URL format", async () => {
    mockInput.mockResolvedValueOnce("https://github.com/user/repo.git").mockResolvedValueOnce("/path/to/worktrees");
    mockSelect.mockResolvedValueOnce("once");
    mockConfirm.mockResolvedValueOnce(false);

    await promptForInitConfig();

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
});
