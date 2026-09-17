import * as path from "path";

import { confirm, input, select } from "@inquirer/prompts";
import * as cron from "node-cron";
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
  // Where the generated config would live. Deliberately a directory none of the
  // answers below point at, so the equal-to-config-dir guard stays quiet unless
  // a test aims at it.
  const CONFIG_DIR = path.join(cwd, "config-home");

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

    const result = await promptForInitConfig(CONFIG_DIR);

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

    const result = await promptForInitConfig(CONFIG_DIR);

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

    const result = await promptForInitConfig(CONFIG_DIR);

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

    const result = await promptForInitConfig(CONFIG_DIR);

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

    const result = await promptForInitConfig(CONFIG_DIR);

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

    const result = await promptForInitConfig(CONFIG_DIR);

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

    const result = await promptForInitConfig(CONFIG_DIR);

    expect(result.repositories[0].worktreeDir).toBe(path.resolve(cwd, "./my-worktrees"));
  });

  it("handles SSH URLs for default worktree directory", async () => {
    mockInput
      .mockResolvedValueOnce("ssh://git@bitbucket.tech.amusnet.io/lc/live-casino-monorepo.git")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("0 * * * *");
    mockSelect.mockResolvedValueOnce("worktree");
    mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    const result = await promptForInitConfig(CONFIG_DIR);

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

    await promptForInitConfig(CONFIG_DIR);

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

    await promptForInitConfig(CONFIG_DIR);

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

    await promptForInitConfig(CONFIG_DIR);

    const cronValidate = mockInput.mock.calls.find((call) => call[0].message?.includes("cron schedule"))?.[0].validate;

    expect(cronValidate).toBeDefined();
    if (cronValidate) {
      expect(cronValidate("a b c d e")).toBe("Invalid cron pattern. Expected format: '* * * * *'");
      expect(cronValidate("")).toBe("Cron schedule is required");
      expect(cronValidate("0 * * * *")).toBe(true);
    }
  });

  // Answering the worktree-dir prompt with the config file's own directory used
  // to be accepted: the generator wrote `worktreeDir: "./"`, the default
  // bareRepoDir `.bare/<name>` landed inside it, and the very next run died on
  // the bareRepoDir/worktreeDir overlap check.
  it("rejects a worktreeDir equal to the config directory in worktree mode", async () => {
    mockInput
      .mockResolvedValueOnce("https://github.com/user/repo.git")
      .mockResolvedValueOnce(path.join(CONFIG_DIR, "worktrees"))
      .mockResolvedValueOnce("0 * * * *");
    mockSelect.mockResolvedValueOnce("worktree");
    mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await promptForInitConfig(CONFIG_DIR);

    const dirValidate = mockInput.mock.calls.find((call) => call[0].message?.includes("storing worktrees"))?.[0]
      .validate;

    expect(dirValidate).toBeDefined();
    if (dirValidate) {
      expect(dirValidate(CONFIG_DIR)).toContain("config file's own directory");
      expect(dirValidate(`${CONFIG_DIR}${path.sep}`)).toContain("config file's own directory");
      expect(dirValidate(path.join(CONFIG_DIR, "sub", ".."))).toContain("config file's own directory");
      expect(dirValidate(path.join(CONFIG_DIR, "worktrees"))).toBe(true);
      expect(dirValidate("/somewhere/else")).toBe(true);
    }
  });

  it("rejects a relative worktreeDir that resolves to the config directory", async () => {
    mockInput
      .mockResolvedValueOnce("https://github.com/user/repo.git")
      .mockResolvedValueOnce("./worktrees")
      .mockResolvedValueOnce("0 * * * *");
    mockSelect.mockResolvedValueOnce("worktree");
    mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    // Relative answers resolve against the cwd, so point the config dir there.
    await promptForInitConfig(cwd);

    const dirValidate = mockInput.mock.calls.find((call) => call[0].message?.includes("storing worktrees"))?.[0]
      .validate;

    expect(dirValidate).toBeDefined();
    if (dirValidate) {
      expect(dirValidate(".")).toContain("config file's own directory");
      expect(dirValidate("./worktrees")).toBe(true);
    }
  });

  it("resolves a relative worktreeDir against the cwd, not the config directory", async () => {
    // The answer is stored as `path.resolve(value)` — relative to the cwd — so
    // the guard has to compare the same thing, or it rejects answers that are
    // fine and accepts ones that are not.
    const elsewhere = path.join(cwd, "elsewhere");
    mockInput
      .mockResolvedValueOnce("https://github.com/user/repo.git")
      .mockResolvedValueOnce("./worktrees")
      .mockResolvedValueOnce("0 * * * *");
    mockSelect.mockResolvedValueOnce("worktree");
    mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await promptForInitConfig(elsewhere);

    const dirValidate = mockInput.mock.calls.find((call) => call[0].message?.includes("storing worktrees"))?.[0]
      .validate;

    expect(dirValidate).toBeDefined();
    if (dirValidate) {
      // "." is the cwd, which is not the config directory here, so it is fine.
      expect(dirValidate(".")).toBe(true);
      expect(dirValidate(elsewhere)).toContain("config file's own directory");
    }
  });

  it("warns but does not reject a clone directory equal to the config directory", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockInput
      .mockResolvedValueOnce("https://github.com/user/repo.git")
      .mockResolvedValueOnce(CONFIG_DIR)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("0 * * * *");
    mockSelect.mockResolvedValueOnce("clone");
    mockConfirm.mockResolvedValueOnce(false);

    const result = await promptForInitConfig(CONFIG_DIR);

    const dirValidate = mockInput.mock.calls.find((call) => call[0].message?.includes("clone into"))?.[0].validate;
    expect(dirValidate).toBeDefined();
    if (dirValidate) {
      expect(dirValidate(CONFIG_DIR)).toBe(true);
    }

    expect(result.repositories[0].worktreeDir).toBe(CONFIG_DIR);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("directory exists and is not empty");
  });

  // Every validator in the wizard tests `value.trim()`, but the raw answer used
  // to be what was stored. `path` never normalizes trailing whitespace away
  // (`path.resolve("./wt ")` is `<cwd>/wt `), so an answer that validated as
  // `./wt` was saved as a different directory — and the generated config then
  // pointed init's own round-trip load at it.
  describe("trims the answers it stores", () => {
    it("stores a worktree repository's repoUrl and worktreeDir without surrounding whitespace", async () => {
      mockInput
        .mockResolvedValueOnce("  https://github.com/user/repo.git  ")
        .mockResolvedValueOnce("  /path/to/worktrees  ")
        .mockResolvedValueOnce("0 * * * *");
      mockSelect.mockResolvedValueOnce("worktree");
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      const result = await promptForInitConfig(CONFIG_DIR);

      expect(result.repositories[0]).toEqual({
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/path/to/worktrees",
        mode: "worktree",
      });
    });

    it("trims a relative worktreeDir before resolving it, not after", async () => {
      // `path.resolve` keeps the space, so an untrimmed "./my-worktrees "
      // becomes "<cwd>/my-worktrees " — a directory one character away from the
      // one the answer named, and the one every later sync would create.
      mockInput
        .mockResolvedValueOnce("https://github.com/user/repo.git")
        .mockResolvedValueOnce("./my-worktrees ")
        .mockResolvedValueOnce("0 * * * *");
      mockSelect.mockResolvedValueOnce("worktree");
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      const result = await promptForInitConfig(CONFIG_DIR);

      expect(result.repositories[0].worktreeDir).toBe(path.resolve(cwd, "./my-worktrees"));
    });

    it("trims a custom bareRepoDir", async () => {
      mockInput
        .mockResolvedValueOnce("https://github.com/user/repo.git")
        .mockResolvedValueOnce("/path/to/worktrees")
        .mockResolvedValueOnce(" /custom/bare/location ")
        .mockResolvedValueOnce("0 * * * *");
      mockSelect.mockResolvedValueOnce("worktree");
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      const result = await promptForInitConfig(CONFIG_DIR);

      expect(result.repositories[0].bareRepoDir).toBe("/custom/bare/location");
    });

    it("warns about a clone directory that is the config directory plus trailing whitespace", async () => {
      // The guard is `pathsEqual(worktreeDir, configDir)`. Against the untrimmed
      // answer that comparison is false, so the one warning telling the user
      // their first clone will fail never printed for a pasted path.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockInput
        .mockResolvedValueOnce("https://github.com/user/repo.git")
        .mockResolvedValueOnce(`${CONFIG_DIR} `)
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("0 * * * *");
      mockSelect.mockResolvedValueOnce("clone");
      mockConfirm.mockResolvedValueOnce(false);

      const result = await promptForInitConfig(CONFIG_DIR);

      expect(result.repositories[0].worktreeDir).toBe(CONFIG_DIR);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("directory exists and is not empty");
    });

    it("stores a cron schedule without surrounding whitespace", async () => {
      // `cron.validate` tolerates a space-padded expression but rejects a tab or
      // a non-breaking space, while the validator here tests `value.trim()`. An
      // answer pasted out of a crontab or a rendered doc page therefore passed
      // the prompt and was written into the config, which init's own round-trip
      // load then refused with "Invalid cron expression in defaults".
      // The non-breaking space is spelled out so the source stays ASCII.
      const padded = `${String.fromCharCode(0xa0)}\t0 * * * *  `;
      mockInput
        .mockResolvedValueOnce("https://github.com/user/repo.git")
        .mockResolvedValueOnce("/path/to/worktrees")
        .mockResolvedValueOnce(padded);
      mockSelect.mockResolvedValueOnce("worktree");
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      const result = await promptForInitConfig(CONFIG_DIR);

      expect(result.cronSchedule).toBe("0 * * * *");
      // The half that makes it a bug rather than a cosmetic difference: the raw
      // answer is what the config loader would have been handed, and it refuses
      // exactly the strings this prompt accepted.
      expect(cron.validate(padded)).toBe(false);
      expect(cron.validate(result.cronSchedule)).toBe(true);
    });

    it("rejects the config directory as worktreeDir even with trailing whitespace", async () => {
      // The guard compares `value.trim()` while the prompt returns the raw
      // string. Now that the answer is trimmed on the way out, a guard reading
      // the raw value would approve `"<configDir> "` and then store exactly
      // `configDir` — the state the guard exists to prevent.
      mockInput
        .mockResolvedValueOnce("https://github.com/user/repo.git")
        .mockResolvedValueOnce(path.join(CONFIG_DIR, "worktrees"))
        .mockResolvedValueOnce("0 * * * *");
      mockSelect.mockResolvedValueOnce("worktree");
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await promptForInitConfig(CONFIG_DIR);

      const dirValidate = mockInput.mock.calls.find((call) => call[0].message?.includes("storing worktrees"))?.[0]
        .validate;

      expect(dirValidate).toBeDefined();
      if (dirValidate) {
        expect(dirValidate(`${CONFIG_DIR} `)).toContain("config file's own directory");
        expect(dirValidate(`  ${CONFIG_DIR}`)).toContain("config file's own directory");
      }
    });

    it("accepts a repository URL with surrounding whitespace instead of calling it malformed", async () => {
      // The URL-shape check was the one validator that read the raw value, so a
      // leading space — the usual artefact of pasting — was reported as "not a
      // valid Git URL" even though the answer would have been trimmed anyway.
      mockInput
        .mockResolvedValueOnce("https://github.com/user/repo.git")
        .mockResolvedValueOnce("/path/to/worktrees")
        .mockResolvedValueOnce("0 * * * *");
      mockSelect.mockResolvedValueOnce("worktree");
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await promptForInitConfig(CONFIG_DIR);

      const validateFn = mockInput.mock.calls.find((call) => call[0].message?.includes("repository URL"))?.[0].validate;

      expect(validateFn).toBeDefined();
      if (validateFn) {
        expect(validateFn("  https://github.com/user/repo.git  ")).toBe(true);
        expect(validateFn("\tgit@github.com:user/repo.git\t")).toBe(true);
        // Still not a URL once trimmed.
        expect(validateFn("  not-a-url  ")).toBe("Please enter a valid Git URL (https://, ssh://, git@, or file://)");
      }
    });
  });

  it("does not warn for a clone directory below the config directory", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockInput
      .mockResolvedValueOnce("https://github.com/user/repo.git")
      .mockResolvedValueOnce(path.join(CONFIG_DIR, "checkout"))
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("0 * * * *");
    mockSelect.mockResolvedValueOnce("clone");
    mockConfirm.mockResolvedValueOnce(false);

    await promptForInitConfig(CONFIG_DIR);

    expect(warn).not.toHaveBeenCalled();
  });
});
