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

  it("collects a single worktree repository and the cron schedule", async () => {
    mockInput
      .mockResolvedValueOnce("https://github.com/user/repo.git")
      .mockResolvedValueOnce("/path/to/worktrees")
      .mockResolvedValueOnce("*/10 * * * *");
    mockSelect.mockResolvedValueOnce("worktree");
    mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false); // custom bare? no; add another? no

    const result = await promptForInitConfig();

    expect(result).toEqual({
      repositories: [
        {
          repoUrl: "https://github.com/user/repo.git",
          worktreeDir: "/path/to/worktrees",
          mode: "worktree",
        },
      ],
      cronSchedule: "*/10 * * * *",
    });
  });

  it("captures a custom bareRepoDir for worktree mode", async () => {
    mockInput
      .mockResolvedValueOnce("https://github.com/user/repo.git")
      .mockResolvedValueOnce("/path/to/worktrees")
      .mockResolvedValueOnce("/custom/bare/location")
      .mockResolvedValueOnce("0 * * * *");
    mockSelect.mockResolvedValueOnce("worktree");
    mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false); // custom bare? yes; add another? no

    const result = await promptForInitConfig();

    expect(result.repositories[0].bareRepoDir).toBe("/custom/bare/location");
  });

  it("captures branch and depth for clone mode", async () => {
    mockInput
      .mockResolvedValueOnce("https://github.com/user/repo.git")
      .mockResolvedValueOnce("/path/to/clone")
      .mockResolvedValueOnce("develop")
      .mockResolvedValueOnce("10")
      .mockResolvedValueOnce("0 * * * *");
    mockSelect.mockResolvedValueOnce("clone");
    mockConfirm.mockResolvedValueOnce(false); // add another? no

    const result = await promptForInitConfig();

    expect(result.repositories[0]).toEqual({
      repoUrl: "https://github.com/user/repo.git",
      worktreeDir: "/path/to/clone",
      mode: "clone",
      branch: "develop",
      depth: 10,
    });
  });

  it("omits branch and depth when left blank in clone mode", async () => {
    mockInput
      .mockResolvedValueOnce("https://github.com/user/repo.git")
      .mockResolvedValueOnce("/path/to/clone")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("0 * * * *");
    mockSelect.mockResolvedValueOnce("clone");
    mockConfirm.mockResolvedValueOnce(false);

    const result = await promptForInitConfig();

    expect(result.repositories[0]).toEqual({
      repoUrl: "https://github.com/user/repo.git",
      worktreeDir: "/path/to/clone",
      mode: "clone",
    });
    expect(result.repositories[0]).not.toHaveProperty("branch");
    expect(result.repositories[0]).not.toHaveProperty("depth");
  });

  it("loops to collect multiple repositories", async () => {
    mockInput
      .mockResolvedValueOnce("https://github.com/user/first.git") // repo1 url
      .mockResolvedValueOnce("/path/first") // repo1 worktreeDir
      .mockResolvedValueOnce("https://github.com/user/second.git") // repo2 url
      .mockResolvedValueOnce("/path/second") // repo2 worktreeDir
      .mockResolvedValueOnce("") // repo2 branch (clone)
      .mockResolvedValueOnce("") // repo2 depth (clone)
      .mockResolvedValueOnce("0 * * * *"); // cron
    mockSelect.mockResolvedValueOnce("worktree").mockResolvedValueOnce("clone");
    mockConfirm
      .mockResolvedValueOnce(false) // repo1 custom bare? no
      .mockResolvedValueOnce(true) // add another? yes
      .mockResolvedValueOnce(false); // add another? no

    const result = await promptForInitConfig();

    expect(result.repositories).toHaveLength(2);
    expect(result.repositories[0].mode).toBe("worktree");
    expect(result.repositories[1].mode).toBe("clone");
    expect(result.repositories[1].worktreeDir).toBe("/path/second");
  });

  it("uses repository name as default worktree directory", async () => {
    mockInput
      .mockResolvedValueOnce("https://github.com/user/my-awesome-repo.git")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("0 * * * *");
    mockSelect.mockResolvedValueOnce("worktree");
    mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    const result = await promptForInitConfig();

    expect(mockInput).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Enter the directory for storing worktrees:",
        default: "./my-awesome-repo",
      }),
    );
    expect(result.repositories[0].worktreeDir).toBe(path.resolve(cwd, "./my-awesome-repo"));
  });

  it("resolves relative paths to absolute", async () => {
    mockInput
      .mockResolvedValueOnce("git@github.com:user/repo.git")
      .mockResolvedValueOnce("./my-worktrees")
      .mockResolvedValueOnce("0 * * * *");
    mockSelect.mockResolvedValueOnce("worktree");
    mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    const result = await promptForInitConfig();

    expect(result.repositories[0].worktreeDir).toBe(path.resolve(cwd, "./my-worktrees"));
  });

  it("handles SSH URLs for default worktree directory", async () => {
    mockInput
      .mockResolvedValueOnce("ssh://git@bitbucket.tech.amusnet.io/lc/live-casino-monorepo.git")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("0 * * * *");
    mockSelect.mockResolvedValueOnce("worktree");
    mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    const result = await promptForInitConfig();

    expect(mockInput).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Enter the directory for storing worktrees:",
        default: "./live-casino-monorepo",
      }),
    );
    expect(result.repositories[0].worktreeDir).toBe(path.resolve(cwd, "./live-casino-monorepo"));
  });

  it("validates URL format", async () => {
    mockInput
      .mockResolvedValueOnce("https://github.com/user/repo.git")
      .mockResolvedValueOnce("/path/to/worktrees")
      .mockResolvedValueOnce("0 * * * *");
    mockSelect.mockResolvedValueOnce("worktree");
    mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await promptForInitConfig();

    const validateFn = mockInput.mock.calls.find((call) => call[0].message?.includes("repository URL"))?.[0].validate;

    expect(validateFn).toBeDefined();
    if (validateFn) {
      expect(validateFn("")).toBe("Repository URL is required");
      expect(validateFn("not-a-url")).toBe("Please enter a valid Git URL (https://, ssh://, git@, or file://)");
      expect(validateFn("https://x")).toContain("Couldn't derive a repository name");
      expect(validateFn("git@host")).toContain("Couldn't derive a repository name");
      expect(validateFn("ssh://host")).toContain("Couldn't derive a repository name");
      expect(validateFn("https://github.com/user/repo.git")).toBe(true);
      expect(validateFn("git@github.com:user/repo.git")).toBe(true);
      expect(validateFn("file:///local/repo.git")).toBe(true);
      expect(validateFn("ssh://git@github.com/user/repo.git")).toBe(true);
    }
  });

  it("validates clone depth as a positive integer", async () => {
    mockInput
      .mockResolvedValueOnce("https://github.com/user/repo.git")
      .mockResolvedValueOnce("/path/to/clone")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("0 * * * *");
    mockSelect.mockResolvedValueOnce("clone");
    mockConfirm.mockResolvedValueOnce(false);

    await promptForInitConfig();

    const depthValidate = mockInput.mock.calls.find((call) => call[0].message?.includes("depth"))?.[0].validate;

    expect(depthValidate).toBeDefined();
    if (depthValidate) {
      expect(depthValidate("")).toBe(true);
      expect(depthValidate("10")).toBe(true);
      expect(depthValidate("0")).toBe("Depth must be a positive integer");
      expect(depthValidate("-3")).toBe("Depth must be a positive integer");
      expect(depthValidate("abc")).toBe("Depth must be a positive integer");
      expect(depthValidate("1.5")).toBe("Depth must be a positive integer");
    }
  });

  it("validates cron schedules with node-cron", async () => {
    mockInput
      .mockResolvedValueOnce("https://github.com/user/repo.git")
      .mockResolvedValueOnce("/path/to/worktrees")
      .mockResolvedValueOnce("0 * * * *");
    mockSelect.mockResolvedValueOnce("worktree");
    mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await promptForInitConfig();

    const cronValidate = mockInput.mock.calls.find((call) => call[0].message?.includes("cron schedule"))?.[0].validate;

    expect(cronValidate).toBeDefined();
    if (cronValidate) {
      expect(cronValidate("a b c d e")).toBe("Invalid cron pattern. Expected format: '* * * * *'");
      expect(cronValidate("")).toBe("Cron schedule is required");
      expect(cronValidate("0 * * * *")).toBe(true);
    }
  });
});
